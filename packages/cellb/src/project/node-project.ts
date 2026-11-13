import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import { applyD1Migrations } from "../bindings/d1-migrations.js";
import {
  analyzeModule,
  exportNamesByModule,
  IMPORT_FROM,
  type ModuleExports,
  prefixModule,
  RESOLVE_MODULE_NAME_SOURCE,
} from "../bindings/module-registry.js";
import {
  compileWasmModules,
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
  wasmModulesOf,
} from "../bindings/worker-loader.js";
import { ctxExports } from "../core/handles.js";
import type { WorkerModule } from "../core/runtime.js";
import { isolatedModuleLoader } from "../isolate/host.js";
import type { PortLike } from "../isolate/protocol.js";
import type { CellStorage } from "../ports.js";
import * as workersClasses from "./cloudflare-workers.js";
import { parseJsonc } from "./jsonc.js";
import { type ModuleRule, moduleRulesPlugin } from "./module-rules.js";
import { ownModule } from "./own-module.js";
import { type WorkerScope, workerScope } from "./worker-scope.js";
import {
  createProjectRuntime,
  hasNodeCompat,
  loadProjectBindings,
  loadTimeEnv,
  type ProjectHost,
  type ProjectRuntime,
  populatesProcessEnv,
  processEnvOf,
  WRANGLER_FILES,
  type WranglerConfig,
} from "./wrangler.js";

/** Reads `wrangler.jsonc` / `wrangler.json` of a project directory (celld reads the same files). */
export function readWranglerConfig(dir: string): WranglerConfig {
  for (const name of WRANGLER_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) return parseJsonc(readFileSync(p, "utf8")) as WranglerConfig;
  }
  throw new Error(`no wrangler.jsonc or wrangler.json in ${dir}`);
}

/** A bare Node.js built-in specifier ("path", "fs/promises"), not one of a package. */
const nodeBuiltinName = new RegExp(
  `^(${builtinModules
    .filter((m) => !m.startsWith("_") && !m.includes(":"))
    .map((m) => m.replace(/[/]/g, "\\/"))
    .join("|")})$`,
);

/** Worker code's `node:fs` under nodejs_compat on Node: Node's own, with workerd's `/bundle`. */
const FS_OVERLAY = `import * as real from "node:fs";
import { bundleFs } from "cellb:bundle-fs";
export * from "node:fs";
const o = bundleFs(real);
export const { existsSync, readFileSync, statSync, lstatSync, readdirSync, accessSync, readFile, stat, lstat, readdir, access, promises } = o;
export default { ...real, ...o };`;
/** Worker code's `node:fs/promises`, the same way. */
const FS_PROMISES_OVERLAY = `import * as real from "node:fs/promises";
import { bundleFsPromises } from "cellb:bundle-fs";
export * from "node:fs/promises";
const o = bundleFsPromises(real);
export const { readFile, stat, lstat, readdir, access } = o;
export default o;`;

/**
 * The modules of loaded code as ES module text, each `import()` the bundler cannot link going to
 * the `cellb:modules` registry instead (module-registry.ts).
 */
function loadedModuleTexts(code: WorkerCode): {
  modules: Record<string, string>;
  registry: string;
} {
  const texts: Record<string, string> = {};
  const names = new Set(Object.keys(code.modules));
  for (const [name, m] of Object.entries(code.modules)) texts[name] = moduleText(m, name, names);
  const modules: Record<string, string> = {};
  const exports = new Map<string, ModuleExports>();
  for (const [name, text] of Object.entries(texts)) {
    // One parse per module: the import() calls to route, and the exports the registry lists.
    const analysis = analyzeModule(text, name);
    exports.set(name, analysis?.exports ?? { names: [], stars: [] });
    const routed = analysis?.routed;
    let prelude =
      routed === undefined ? "" : `import { importFrom as ${IMPORT_FROM} } from "cellb:modules"; `;
    // The main module evaluates the registry, so it is there before any code runs.
    if (name === code.mainModule && !prelude) prelude = 'import "cellb:modules"; ';
    modules[name] = prelude ? prefixModule(routed ?? text, prelude) : text;
  }
  return { modules, registry: registrySource(Object.keys(texts), exports, code.mainModule) };
}

/**
 * What an import of loaded code that names none of its modules becomes: a module that throws when
 * it is evaluated, so the failure comes where workerd's would (when the importing module runs), not
 * at build time or when an unrelated module loads. CommonJS, so any named import of it builds.
 */
function missingModule(spec: string, importer: string) {
  const message = `No such module "${spec}" (imported from "${importer}")`;
  return {
    path: `${importer}\u0000${spec}`,
    namespace: "cells-missing",
    pluginData: `throw new Error(${JSON.stringify(message)});\nmodule.exports = {};`,
  };
}

/**
 * The `cellb:modules` registry of a bundle of loaded code: each module, imported on demand. It
 * also publishes itself as `globalThis.__cellbLoadedModules`, where an isolate thread's module
 * hooks find it (node-entry.ts: `import()` from code built with `Function`).
 */
function registrySource(
  names: string[],
  exports: Map<string, ModuleExports>,
  main: string,
): string {
  const q = JSON.stringify;
  return [
    `const names = new Set(${q(names)});`,
    `const resolve = ${RESOLVE_MODULE_NAME_SOURCE};`,
    `const table = { ${names.map((n) => `${q(n)}: () => import(${q(`memory:${n}`)})`).join(", ")} };`,
    "export const importFrom = (spec, importer) => {",
    "  const name = resolve(String(spec), importer, names);",
    "  return name === undefined ? import(spec) : table[name]();",
    "};",
    `globalThis.__cellbLoadedModules = { main: ${q(main)}, names, exportNames: ${q(exportNamesByModule(exports))}, load: (name) => table[name]() };`,
  ].join("\n");
}

/**
 * Node host: bundles `main` with esbuild (as `celld deploy` does) and builds the runtime.
 * `cloudflare:workers` resolves to cellb's module so user classes extend the
 * runtime's own DurableObject / WorkerEntrypoint.
 */
/** Bundles Worker code (a file, or in-memory modules) with the runtime's module mappings, then imports it. */
export async function bundleWorker(
  entry:
    | { path: string }
    | {
        modules: Record<string, string>;
        main: string;
        /** The `cellb:modules` registry the modules import (loadedModuleTexts). */
        registry?: string;
      },
  logs?: LogSink,
  outbound?: typeof fetch,
  opts: {
    nodeCompat?: boolean;
    standardBinaryType?: boolean;
    scope?: WorkerScope;
    /** wrangler `rules` for non-JS imports (the defaults: `.wasm`, `.bin`, `.txt`…, as wrangler). */
    rules?: ModuleRule[];
  } = {},
): Promise<WorkerModule> {
  // `env` and `exports` of `cloudflare:workers` belong to one Worker: the bundle reads them
  // from its own scope (empty objects for code that has none).
  const scopeKey = opts.scope ? `s${Math.random().toString(36).slice(2)}` : "";
  if (opts.scope) {
    const g = globalThis as Record<string, unknown>;
    g.__cellsWorkerScopes ??= {};
    (g.__cellsWorkerScopes as Record<string, unknown>)[scopeKey] = opts.scope;
  }
  // Loaded code gets a bundle-local `fetch` (globalOutbound policy)…
  const outboundKey = outbound ? `o${Math.random().toString(36).slice(2)}` : "";
  if (outbound) {
    const g = globalThis as Record<string, unknown>;
    g.__cellsOutbound ??= {};
    (g.__cellsOutbound as Record<string, unknown>)[outboundKey] = outbound;
  }
  // …and a bundle-local `console` that also feeds its Tail Workers.
  const consoleKey = logs ? `c${Math.random().toString(36).slice(2)}` : "";
  if (logs) {
    const g = globalThis as Record<string, unknown>;
    g.__cellsConsoles ??= {};
    const registry = g.__cellsConsoles as Record<string, unknown>;
    const real = globalThis.console;
    const wrap =
      (level: "log" | "info" | "warn" | "error" | "debug") =>
      (...args: unknown[]) => {
        logs(level, args);
        real[level](...args);
      };
    registry[consoleKey] = Object.assign(Object.create(real), {
      log: wrap("log"),
      info: wrap("info"),
      warn: wrap("warn"),
      error: wrap("error"),
      debug: wrap("debug"),
    });
  }
  const outDir = mkdtempSync(join(tmpdir(), "cells-worker-"));
  const out = join(outDir, "worker.mjs");
  const cfWorkers = ownModule(import.meta.dirname, "cloudflare-workers");
  // This bundle's `cloudflare:workers`: the runtime's classes plus its own `env` and `exports`.
  // A file of its own, kept out of the bundle so it adds no names to the Worker's scope.
  const workersModule = join(outDir, "cloudflare-workers.mjs");
  writeFileSync(
    workersModule,
    [
      `export * from ${JSON.stringify(cfWorkers)};`,
      `const scope = globalThis.__cellsWorkerScopes?.[${JSON.stringify(scopeKey)}];`,
      "export const env = scope ? scope.env : {};",
      "export const exports = scope ? scope.exports : {};",
      "export const waitUntil = (p) => scope?.waitUntil(p);",
    ].join("\n"),
  );
  const memory = "modules" in entry ? entry.modules : undefined;
  await build({
    entryPoints: [
      memory ? `memory:${(entry as { main: string }).main}` : (entry as { path: string }).path,
    ],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "neutral",
    // As `celld deploy` resolves packages: workerd's conditions, then `module` and `main` (the
    // neutral platform has no main fields, so a package with only `main` would not resolve).
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    target: "es2022",
    logLevel: "silent",
    // nodejs_compat: CommonJS dependencies `require()` Node's built-ins (mime-types requires
    // node:path), as they may under workerd's nodejs_compat. In an ES module bundle esbuild's
    // require shim needs a `require` in scope: vitest's module runner provides one, plain Node
    // does not.
    ...(opts.nodeCompat
      ? {
          banner: {
            js: 'import { createRequire as __cellbCreateRequire } from "node:module";\nconst require = __cellbCreateRequire(import.meta.url);',
          },
        }
      : {}),
    inject: [
      ownModule(import.meta.dirname, "workers-globals"),
      ...(logs ? ["cellb:console"] : []),
      ...(outbound ? ["cellb:fetch"] : []),
    ],
    plugins: [
      {
        name: "cells-modules",
        setup(b) {
          b.onResolve({ filter: /^cellb:console$/ }, () => ({
            path: "console",
            namespace: "cells-console",
          }));
          // nodejs_compat on a Node host: `node:*` are the real Node.js modules, except that
          // `node:fs` also reads workerd's `/bundle` (node-compat/bundle-files.ts).
          if (opts.nodeCompat) {
            b.onResolve({ filter: /^(node:)?fs(\/promises)?$/ }, (a) => {
              const name = a.path.replace(/^node:/, "");
              return a.namespace === "cells-fs"
                ? { path: `node:${name}`, external: true }
                : { path: name, namespace: "cells-fs" };
            });
            b.onResolve({ filter: /^cellb:bundle-fs$/ }, () => ({
              path: ownModule(join(import.meta.dirname, "../node-compat"), "bundle-files"),
              external: true,
            }));
            b.onLoad({ filter: /.*/, namespace: "cells-fs" }, (a) => ({
              contents: a.path === "fs" ? FS_OVERLAY : FS_PROMISES_OVERLAY,
              loader: "js",
            }));
            b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, external: true }));
            // workerd's nodejs_compat also takes the bare names ("path", "fs/promises").
            b.onResolve({ filter: nodeBuiltinName }, (a) => ({
              path: `node:${a.path}`,
              external: true,
            }));
          }
          b.onResolve({ filter: /^cellb:compat$/ }, () => ({
            path: "compat",
            namespace: "cells-compat",
          }));
          b.onLoad({ filter: /.*/, namespace: "cells-compat" }, () => ({
            contents: `export const standardBinaryType = ${!!opts.standardBinaryType};`,
            loader: "js",
          }));
          b.onResolve({ filter: /^cellb:fetch$/ }, () => ({
            path: "fetch",
            namespace: "cells-fetch",
          }));
          b.onLoad({ filter: /.*/, namespace: "cells-fetch" }, () => ({
            contents: `export const fetch = globalThis.__cellsOutbound[${JSON.stringify(outboundKey)}];`,
            loader: "js",
          }));
          b.onLoad({ filter: /.*/, namespace: "cells-console" }, () => ({
            contents: `export const console = globalThis.__cellsConsoles[${JSON.stringify(consoleKey)}];`,
            loader: "js",
          }));
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: workersModule,
            external: true,
          }));
          b.onResolve({ filter: /^cloudflare:email$/ }, () => ({
            path: ownModule(import.meta.dirname, "cloudflare-email"),
            external: true,
          }));
          b.onResolve({ filter: /^cellb:ws$/ }, () => ({
            path: ownModule(import.meta.dirname, "workers-globals-module"),
            external: true,
          }));
          if (!memory) return;
          b.onResolve({ filter: /^memory:/ }, (a) => ({
            path: a.path.slice(7),
            namespace: "memory",
          }));
          b.onResolve({ filter: /^\.{1,2}\// }, (a) => {
            if (a.namespace !== "memory") return undefined;
            const path = new URL(a.path, `file:///${a.importer}`).pathname.slice(1);
            // Not one of the loaded modules: it fails when it runs, as on workerd (missingModule).
            return path in memory
              ? { path, namespace: "memory" }
              : missingModule(a.path, a.importer);
          });
          b.onLoad({ filter: /.*/, namespace: "memory" }, (a) => ({
            contents: memory[a.path],
            loader: "js",
          }));
          b.onResolve({ filter: /^cellb:modules$/ }, () => ({
            path: "modules",
            namespace: "cells-modules",
          }));
          b.onLoad({ filter: /.*/, namespace: "cells-modules" }, () => ({
            contents:
              (entry as { registry?: string }).registry ??
              "export const importFrom = (s) => import(s);",
            loader: "js",
          }));
          // Anything else loaded code imports: a module's whole name (a URL, say), as workerd names
          // modules, or else a module that throws when it is evaluated (missingModule).
          b.onResolve({ filter: /.*/ }, (a) => {
            if (a.namespace !== "memory") return undefined;
            if (a.path in memory) return { path: a.path, namespace: "memory" };
            return missingModule(a.path, a.importer);
          });
          b.onLoad({ filter: /.*/, namespace: "cells-missing" }, (a) => ({
            contents: a.pluginData as string,
            loader: "js",
          }));
        },
      },
      moduleRulesPlugin(opts.rules),
    ],
  });
  return (await import(/* @vite-ignore */ out)) as WorkerModule;
}

/** Worker Loader on Node: compiles `WorkerCode.modules` with esbuild (as celld compiles loaded code). */
export const nodeModuleLoader: ModuleLoader = async (_id, loaded, logs) => {
  const code = await compileWasmModules(loaded);
  const outbound = outboundFetch(code);
  const { modules, registry } = loadedModuleTexts(code);
  // `env` and `exports` of the loaded code's `cloudflare:workers` are its own (WorkerCode.env).
  const env = code.env ?? {};
  const scope = workerScope(env);
  const module = (await bundleWorker({ modules, main: code.mainModule, registry }, logs, outbound, {
    scope,
  })) as Record<string, unknown>;
  scope.bind({ env, exports: ctxExports(module, env) });
  return module;
};

export async function loadNodeProject(
  dir: string,
  host: Omit<ProjectHost, "loadModules"> & Partial<Pick<ProjectHost, "loadModules">>,
): Promise<ProjectRuntime & { config: WranglerConfig }> {
  const config = readWranglerConfig(dir);
  if (!config.main && !config.assets)
    throw new Error("wrangler config has neither `main` nor `assets`");
  const flags = config.compatibility_flags ?? [];
  const nodeCompat = hasNodeCompat(config);
  const standardBinaryType = flags.includes("websocket_standard_binary_type");
  // The module reads `env` from `cloudflare:workers` while it is evaluated, before the
  // runtime exists: until then the scope holds the configuration's vars (and `ai`).
  const scope = workerScope(loadTimeEnv(config, host.ai));
  // A bundle built elsewhere for cellb (cellbHostModule: webrun-bundler in a browser, say) reads
  // the runtime from globals, as in the browser realm: set them here too, so the same bundle
  // runs on Node. (One such project per process: the globals are the process's.)
  installHostModuleGlobals(scope);
  // As the browser host: nodejs_compat fills process.env with the text vars (from compatibility
  // date 2025-04-01). Node shares its real process with the Worker, so they land there.
  if (populatesProcessEnv(config))
    for (const [k, v] of Object.entries(processEnvOf(config))) process.env[k] ??= v;
  const module = config.main
    ? await bundleWorker({ path: resolve(dir, config.main) }, undefined, undefined, {
        nodeCompat,
        standardBinaryType,
        scope,
        rules: config.rules,
      })
    : ({ default: {} } as WorkerModule);
  const assetFiles = config.assets?.directory
    ? readAssetDirectory(resolve(dir, config.assets.directory))
    : undefined;
  const project = createProjectRuntime(config, module, {
    bindings: await loadProjectBindings(config),
    loadModules: nodeModuleLoader,
    // own realm, as celld; facets logged like the root's
    isolatedModules: nodeIsolatedLoader(() => host.storage),
    assetFiles,
    ...host,
  });
  scope.bind(project.runtime);
  return { ...project, config };
}

/** Reads an assets directory into "/path" → bytes (what `celld deploy` uploads). */
export function readAssetDirectory(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, new Uint8Array(readFileSync(full)));
    }
  };
  walk(root, "/");
  return files;
}

/**
 * `celld d1 migrations apply DATABASE` for a Node-hosted project: reads
 * `migrations_dir` (default "migrations") of the `d1_databases` entry and applies what is new.
 */
export async function applyNodeD1Migrations(
  dir: string,
  runtime: { env: Record<string, unknown> },
  database: string,
) {
  const config = readWranglerConfig(dir);
  const d1 = config.d1_databases?.find(
    (d) => d.database_name === database || d.binding === database,
  );
  if (!d1) throw new Error(`no d1_databases entry named ${database}`);
  const mdir = resolve(dir, (d1 as { migrations_dir?: string }).migrations_dir ?? "migrations");
  const files: [string, string][] = existsSync(mdir)
    ? readdirSync(mdir).map((f) => [f, readFileSync(join(mdir, f), "utf8")])
    : [];
  return applyD1Migrations(
    runtime.env[d1.binding] as never,
    files,
    (d1 as { migrations_table?: string }).migrations_table ?? "d1_migrations",
  );
}

/**
 * Loaded Workers in worker threads (one realm each), like celld's isolates. The code is
 * bundled with esbuild (cloudflare:workers bundled in) and imported in the thread from a
 * data: URL; Durable Object classes for facets still load in this realm.
 */
let isolateEntry: Promise<string> | undefined;
export function nodeIsolatedLoader(storage?: () => CellStorage | undefined): ModuleLoader {
  return isolatedModuleLoader({
    storage,
    spawn: () => {
      const port = new NodeWorker(new URL(`file://${isolateEntryPathSync()}`));
      port.unref(); // an idle isolate never keeps the process alive
      return { port: port as unknown as PortLike, terminate: () => void port.terminate() };
    },
    prepare: async (_id, loaded) => {
      isolateEntry ??= buildIsolateEntry();
      const [code] = await Promise.all([compileWasmModules(loaded), isolateEntry]);
      const { modules, registry } = loadedModuleTexts(code);
      const out = await build({
        entryPoints: [`memory:${code.mainModule}`],
        write: false,
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        logLevel: "silent",
        plugins: [
          {
            name: "isolate-modules",
            setup(b) {
              // The loaded Worker is its thread's own: `env` and `exports` are the scope
              // serveIsolate keeps for it.
              b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
                path: "cloudflare:workers",
                namespace: "isolate-workers",
              }));
              b.onLoad({ filter: /.*/, namespace: "isolate-workers" }, () => ({
                contents: [
                  // cloudflare-workers.js in the published package (dist/), .ts in the sources.
                  `export * from ${JSON.stringify(ownModule(import.meta.dirname, "cloudflare-workers"))};`,
                  "export const env = globalThis.__cellsProjectScope.env, exports = globalThis.__cellsProjectScope.exports, waitUntil = (p) => globalThis.__cellsProjectScope.waitUntil(p);",
                ].join("\n"),
                loader: "js",
                resolveDir: import.meta.dirname,
              }));
              b.onResolve({ filter: /^cloudflare:email$/ }, () => ({
                path: ownModule(import.meta.dirname, "cloudflare-email"),
              }));
              b.onResolve({ filter: /^memory:/ }, (a) => ({
                path: a.path.slice(7),
                namespace: "memory",
              }));
              b.onResolve({ filter: /^\.{1,2}\// }, (a) => {
                if (a.namespace !== "memory") return undefined;
                const path = new URL(a.path, `file:///${a.importer}`).pathname.slice(1);
                // Not one of the loaded modules: it fails when it runs, as on workerd (missingModule).
                return path in modules
                  ? { path, namespace: "memory" }
                  : missingModule(a.path, a.importer);
              });
              b.onLoad({ filter: /.*/, namespace: "memory" }, (a) => ({
                contents: modules[a.path],
                loader: "js",
              }));
              b.onResolve({ filter: /^cellb:modules$/ }, () => ({
                path: "modules",
                namespace: "cells-modules",
              }));
              b.onLoad({ filter: /.*/, namespace: "cells-modules" }, () => ({
                contents: registry,
                loader: "js",
              }));
              // Anything else loaded code imports: a module's whole name (a URL, say), as workerd names
              // modules, or else a module that throws when it is evaluated (missingModule).
              b.onResolve({ filter: /.*/ }, (a) => {
                if (a.namespace !== "memory") return undefined;
                if (a.path in modules) return { path: a.path, namespace: "memory" };
                return missingModule(a.path, a.importer);
              });
              b.onLoad({ filter: /.*/, namespace: "cells-missing" }, (a) => ({
                contents: a.pluginData as string,
                loader: "js",
              }));
            },
          },
        ],
      });
      // Compiled wasm modules travel beside the source (a worker thread takes them as they are).
      return { source: out.outputFiles[0].text, wasm: wasmModulesOf(code) };
    },
  });
}

let isolateEntryFile = "";
function isolateEntryPathSync(): string {
  if (!isolateEntryFile) throw new Error("isolate entry not built yet");
  return isolateEntryFile;
}
async function buildIsolateEntry(): Promise<string> {
  isolateEntryFile = join(mkdtempSync(join(tmpdir(), "cells-isolate-")), "isolate.mjs");
  await build({
    entryPoints: [ownModule(import.meta.dirname, "../isolate/node-entry")],
    outfile: isolateEntryFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return isolateEntryFile;
}

/** The globals `@statewalker/cellb/host-modules` bundles read (see host-modules.ts). */
function installHostModuleGlobals(scope: WorkerScope): void {
  const g = globalThis as Record<string, unknown>;
  g.__cellsProjectScope = scope;
  g.__cellsWorkersModule ??= workersClasses;
  // node:* from Node itself (the browser realm gives cellb's polyfills).
  g.__cellsNodeModules ??= new Proxy(
    {},
    { get: (_t, k) => (typeof k === "string" ? requireBuiltin(k) : undefined) },
  );
}
const requireBuiltin = createRequire(import.meta.url);
