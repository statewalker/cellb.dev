import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { type FilesApi, readFile, readText, tryReadText } from "@statewalker/webrun-files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
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
import { PROJECT_WORKERS_MODULE_SHIM, WORKERS_CLASSES } from "./browser-modules.js";
import * as cloudflareEmail from "./cloudflare-email.js";
import * as workersModule from "./cloudflare-workers.js";
import { parseJsonc } from "./jsonc.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import {
  BARE_BUILTINS,
  bundleWorkerSource,
  EMAIL_MODULE_SHIM,
  type WorkerSource,
} from "./worker-bundler.js";
import { type WorkerScope, workerScope } from "./worker-scope.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";
import * as workersGlobals from "./workers-globals-module.js";
import {
  createProjectRuntime,
  loadTimeEnv,
  type ProjectHost,
  type ProjectRuntime,
  type WranglerConfig,
} from "./wrangler.js";

/** A project: a directory on disk, or a directory of a FilesApi. */
export type ProjectSource = string | { files: FilesApi; root?: string };

/** The FilesApi and directory a project is read from. */
function projectFiles(project: ProjectSource): { files: FilesApi; root: string } {
  return typeof project === "string"
    ? { files: new NodeFilesApi({ rootDir: resolve(project) }), root: "/" }
    : { files: project.files, root: project.root ?? "/" };
}

const at = (root: string, path: string) =>
  `${root === "/" ? "" : root.replace(/\/+$/, "")}/${path.replace(/^\.?\/+/, "")}`;

/** Reads `wrangler.jsonc` / `wrangler.json` of a project (celld reads the same files). */
export async function readWranglerConfig(project: ProjectSource): Promise<WranglerConfig> {
  const { files, root } = projectFiles(project);
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const text = await tryReadText(files, at(root, name));
    if (text !== undefined) return parseJsonc(text) as WranglerConfig;
  }
  throw new Error(
    `no wrangler.jsonc or wrangler.json in ${typeof project === "string" ? project : root}`,
  );
}

/** The runtime's modules that Node bundles read (`cloudflare:workers` classes, `cloudflare:email`). */
function installRuntimeModules() {
  const g = globalThis as Record<string, unknown>;
  g.__cellsWorkersModule ??= workersModule;
  g.__cellsEmailModule ??= cloudflareEmail;
}

/** A per-bundle value on `globalThis[registry][key]`, read back by the bundle's own modules. */
function register(registry: string, value: unknown): string {
  const g = globalThis as unknown as Record<string, Record<string, unknown>>;
  const key = `k${Math.random().toString(36).slice(2)}`;
  g[registry] ??= {};
  g[registry][key] = value;
  return `globalThis.${registry}[${JSON.stringify(key)}]`;
}

/**
 * Node host: bundles Worker code (a file, a file of a FilesApi, or Worker Loader modules) with
 * webrun-bundler, reading every file through a FilesApi, and imports it from a `data:` URL (no
 * file is written). The runtime's own modules are the host's: `cloudflare:workers` gives the
 * runtime's DurableObject / WorkerEntrypoint (user classes extend them) and the Worker's own
 * `env` and `exports`; the Workers globals and `cloudflare:email` are the runtime's; with
 * nodejs_compat, `node:*` (and the bare names) are Node's own modules.
 */
export async function bundleWorker(
  entry: WorkerSource,
  logs?: LogSink,
  outbound?: typeof fetch,
  opts: { nodeCompat?: boolean; standardBinaryType?: boolean; scope?: WorkerScope } = {},
): Promise<WorkerModule> {
  installRuntimeModules();
  // `env` and `exports` of `cloudflare:workers` belong to one Worker: the bundle reads them
  // from its own scope (empty objects for code that has none).
  const scope = opts.scope ? register("__cellsWorkerScopes", opts.scope) : "";
  const workers = `${WORKERS_CLASSES} export const env = ${scope ? `${scope}.env` : "{}"}, exports = ${scope ? `${scope}.exports` : "{}"};`;
  // The Workers globals, with this project's `websocket_standard_binary_type`.
  const globals = register("__cellsBundleGlobals", {
    ...workersGlobals,
    Request: workersGlobals.CellsRequest,
    Response: workersGlobals.CellsResponse,
    WebSocketPair: opts.standardBinaryType
      ? workersGlobals.StandardWebSocketPair
      : workersGlobals.WebSocketPair,
  });
  const globalsShim = `${WORKERS_GLOBAL_NAMES.map((n) => `export const ${n} = ${globals}.${n};`).join(" ")} export const scheduler = ${SCHEDULER_EXPRESSION};`;
  // Loaded code gets a bundle-local `fetch` (globalOutbound policy)…
  const fetchShim = outbound && `export const fetch = ${register("__cellsOutbound", outbound)};`;
  // …and a bundle-local `console` that also feeds its Tail Workers.
  let consoleShim: string | undefined;
  if (logs) {
    const real = globalThis.console;
    const wrap =
      (level: "log" | "info" | "warn" | "error" | "debug") =>
      (...args: unknown[]) => {
        logs(level, args);
        real[level](...args);
      };
    const console = Object.assign(Object.create(real), {
      log: wrap("log"),
      info: wrap("info"),
      warn: wrap("warn"),
      error: wrap("error"),
      debug: wrap("debug"),
    });
    consoleShim = `export const console = ${register("__cellsConsoles", console)};`;
  }
  const shims: Record<string, string | undefined> = {
    "cloudflare:workers": workers,
    "cloudflare:email": EMAIL_MODULE_SHIM,
    "cellb:globals": globalsShim,
    "cellb:fetch": fetchShim,
    "cellb:console": consoleShim,
  };
  const { code } = await bundleWorkerSource(entry, {
    platform: "neutral",
    // nodejs_compat on a Node host: `node:*` are the real Node.js modules; workerd's
    // nodejs_compat also takes the bare names ("path", "fs/promises").
    external: opts.nodeCompat ? ["node:*", ...BARE_BUILTINS] : [],
    inject: [
      "cellb:globals",
      ...(fetchShim ? ["cellb:fetch"] : []),
      ...(consoleShim ? ["cellb:console"] : []),
    ],
    modules: (spec) => shims[spec],
    name: "path" in entry ? entry.path : "main" in entry ? entry.main : entry.entry,
  });
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return (await import(/* @vite-ignore */ url)) as WorkerModule;
}

/** Worker Loader on Node: bundles `WorkerCode.modules` (as celld compiles loaded code). */
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
  dir: ProjectSource,
  host: Omit<ProjectHost, "loadModules"> & Partial<Pick<ProjectHost, "loadModules">>,
): Promise<ProjectRuntime & { config: WranglerConfig }> {
  const { files, root } = projectFiles(dir);
  const config = await readWranglerConfig({ files, root });
  if (!config.main && !config.assets)
    throw new Error("wrangler config has neither `main` nor `assets`");
  const flags = config.compatibility_flags ?? [];
  const nodeCompat = flags.some((f) => f.startsWith("nodejs_compat"));
  const standardBinaryType = flags.includes("websocket_standard_binary_type");
  // The module reads `env` from `cloudflare:workers` while it is evaluated, before the
  // runtime exists: until then the scope holds the configuration's vars (and `ai`).
  const scope = workerScope(loadTimeEnv(config, host.ai));
  // A project on disk is bundled from the disk's root, so that its packages resolve from the
  // folders above it as Node finds them; a FilesApi project from its own root.
  const main = config.main
    ? typeof dir === "string"
      ? { path: resolve(dir, config.main) }
      : { files, root, entry: at("/", config.main) }
    : undefined;
  const module = main
    ? await bundleWorker(main, undefined, undefined, { nodeCompat, standardBinaryType, scope })
    : ({ default: {} } as WorkerModule);
  const assetFiles = config.assets?.directory
    ? await readAssetDirectory({ files, root: at(root, config.assets.directory) })
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
export async function readAssetDirectory(dir: ProjectSource): Promise<Map<string, Uint8Array>> {
  const { files, root } = projectFiles(dir);
  const base = root === "/" ? "" : root.replace(/\/+$/, "");
  const out = new Map<string, Uint8Array>();
  for await (const f of files.list(root, { recursive: true }))
    if (f.kind === "file") out.set(f.path.slice(base.length), await readFile(files, f.path));
  return out;
}

/**
 * `celld d1 migrations apply DATABASE` for a Node-hosted project: reads
 * `migrations_dir` (default "migrations") of the `d1_databases` entry and applies what is new.
 */
export async function applyNodeD1Migrations(
  dir: ProjectSource,
  runtime: { env: Record<string, unknown> },
  database: string,
) {
  const { files, root } = projectFiles(dir);
  const config = await readWranglerConfig({ files, root });
  const d1 = config.d1_databases?.find(
    (d) => d.database_name === database || d.binding === database,
  );
  if (!d1) throw new Error(`no d1_databases entry named ${database}`);
  const mdir = at(root, (d1 as { migrations_dir?: string }).migrations_dir ?? "migrations");
  const migrations: [string, string][] = [];
  for await (const f of files.list(mdir))
    if (f.kind === "file") migrations.push([f.name, await readText(files, f.path)]);
  return applyD1Migrations(
    runtime.env[d1.binding] as never,
    migrations,
    (d1 as { migrations_table?: string }).migrations_table ?? "d1_migrations",
  );
}

/**
 * Loaded Workers in worker threads (one realm each), like celld's isolates. The code is
 * bundled with webrun-bundler (its `cloudflare:workers` reads the thread's runtime) and
 * imported in the thread from a data: URL; Durable Object classes for facets still load in
 * this realm. The thread's own entry (cellb's isolate runtime) is built once, from cellb's
 * sources.
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
      // The loaded Worker is its thread's own: `cloudflare:workers` gives the thread's runtime
      // classes and the scope serveIsolate keeps for it (node-entry installs both).
      const { code: source } = await bundleWorkerSource(
        { modules, main: code.mainModule },
        {
          platform: "neutral",
          modules: (spec) =>
            spec === "cloudflare:workers"
              ? PROJECT_WORKERS_MODULE_SHIM
              : spec === "cloudflare:email"
                ? EMAIL_MODULE_SHIM
                : undefined,
          name: code.mainModule,
        },
      );
      return { source };
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
