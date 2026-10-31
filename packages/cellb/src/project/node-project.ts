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
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
} from "../bindings/worker-loader.js";
import { ctxExports } from "../core/handles.js";
import type { WorkerModule } from "../core/runtime.js";
import { isolatedModuleLoader } from "../isolate/host.js";
import type { PortLike } from "../isolate/protocol.js";
import type { CellStorage } from "../ports.js";
import * as workersClasses from "./cloudflare-workers.js";
import { parseJsonc } from "./jsonc.js";
import { type WorkerScope, workerScope } from "./worker-scope.js";
import {
  createProjectRuntime,
  loadTimeEnv,
  type ProjectHost,
  type ProjectRuntime,
  type WranglerConfig,
} from "./wrangler.js";

/** Reads `wrangler.jsonc` / `wrangler.json` of a project directory (celld reads the same files). */
export function readWranglerConfig(dir: string): WranglerConfig {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
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

/**
 * Node host: bundles `main` with esbuild (as `celld deploy` does) and builds the runtime.
 * `cloudflare:workers` resolves to cellb's module so user classes extend the
 * runtime's own DurableObject / WorkerEntrypoint.
 */
/** Bundles Worker code (a file, or in-memory modules) with the runtime's module mappings, then imports it. */
export async function bundleWorker(
  entry: { path: string } | { modules: Record<string, string>; main: string },
  logs?: LogSink,
  outbound?: typeof fetch,
  opts: { nodeCompat?: boolean; standardBinaryType?: boolean; scope?: WorkerScope } = {},
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
  const cfWorkers = resolve(import.meta.dirname, "cloudflare-workers.ts");
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
    inject: [
      resolve(import.meta.dirname, "workers-globals.ts"),
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
          // nodejs_compat on a Node host: `node:*` are the real Node.js modules.
          if (opts.nodeCompat) {
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
            path: resolve(import.meta.dirname, "cloudflare-email.ts"),
            external: true,
          }));
          b.onResolve({ filter: /^cellb:ws$/ }, () => ({
            path: resolve(import.meta.dirname, "workers-globals-module.ts"),
            external: true,
          }));
          if (!memory) return;
          b.onResolve({ filter: /^memory:/ }, (a) => ({
            path: a.path.slice(7),
            namespace: "memory",
          }));
          b.onResolve({ filter: /^\.{1,2}\// }, (a) =>
            a.namespace === "memory"
              ? {
                  path: new URL(a.path, `file:///${a.importer}`).pathname.slice(1),
                  namespace: "memory",
                }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "memory" }, (a) => ({
            contents: memory[a.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return (await import(/* @vite-ignore */ out)) as WorkerModule;
}

/** Worker Loader on Node: compiles `WorkerCode.modules` with esbuild (as celld compiles loaded code). */
export const nodeModuleLoader: ModuleLoader = async (_id, code, logs) => {
  const outbound = outboundFetch(code);
  const modules: Record<string, string> = {};
  for (const [name, m] of Object.entries(code.modules)) modules[name] = moduleText(m);
  // `env` and `exports` of the loaded code's `cloudflare:workers` are its own (WorkerCode.env).
  const env = code.env ?? {};
  const scope = workerScope(env);
  const module = (await bundleWorker({ modules, main: code.mainModule }, logs, outbound, {
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
  const nodeCompat = flags.some((f) => f.startsWith("nodejs_compat"));
  const standardBinaryType = flags.includes("websocket_standard_binary_type");
  // The module reads `env` from `cloudflare:workers` while it is evaluated, before the
  // runtime exists: until then the scope holds the configuration's vars (and `ai`).
  const scope = workerScope(loadTimeEnv(config, host.ai));
  // A bundle built elsewhere for cellb (cellbHostModule: webrun-bundler in a browser, say) reads
  // the runtime from globals, as in the browser realm: set them here too, so the same bundle
  // runs on Node. (One such project per process: the globals are the process's.)
  installHostModuleGlobals(scope);
  const module = config.main
    ? await bundleWorker({ path: resolve(dir, config.main) }, undefined, undefined, {
        nodeCompat,
        standardBinaryType,
        scope,
      })
    : ({ default: {} } as WorkerModule);
  const assetFiles = config.assets?.directory
    ? readAssetDirectory(resolve(dir, config.assets.directory))
    : undefined;
  const project = createProjectRuntime(config, module, {
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
    prepare: async (_id, code) => {
      isolateEntry ??= buildIsolateEntry();
      await isolateEntry;
      const modules: Record<string, string> = {};
      for (const [name, m] of Object.entries(code.modules)) modules[name] = moduleText(m);
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
                  'export * from "./cloudflare-workers.ts";',
                  "export const env = globalThis.__cellsProjectScope.env, exports = globalThis.__cellsProjectScope.exports, waitUntil = (p) => globalThis.__cellsProjectScope.waitUntil(p);",
                ].join("\n"),
                loader: "js",
                resolveDir: import.meta.dirname,
              }));
              b.onResolve({ filter: /^cloudflare:email$/ }, () => ({
                path: resolve(import.meta.dirname, "cloudflare-email.ts"),
              }));
              b.onResolve({ filter: /^memory:/ }, (a) => ({
                path: a.path.slice(7),
                namespace: "memory",
              }));
              b.onResolve({ filter: /^\.{1,2}\// }, (a) =>
                a.namespace === "memory"
                  ? {
                      path: new URL(a.path, `file:///${a.importer}`).pathname.slice(1),
                      namespace: "memory",
                    }
                  : undefined,
              );
              b.onLoad({ filter: /.*/, namespace: "memory" }, (a) => ({
                contents: modules[a.path],
                loader: "js",
              }));
            },
          },
        ],
      });
      return { source: out.outputFiles[0].text };
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
    entryPoints: [resolve(import.meta.dirname, "../isolate/node-entry.ts")],
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
