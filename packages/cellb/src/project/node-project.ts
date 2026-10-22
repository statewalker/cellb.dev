import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import { applyD1Migrations } from "../bindings/d1-migrations.js";
import { type LogSink, type ModuleLoader, outboundFetch } from "../bindings/worker-loader.js";
import type { WorkerModule } from "../core/runtime.js";
import { isolatedModuleLoader } from "../isolate/host.js";
import type { PortLike } from "../isolate/protocol.js";
import { parseJsonc } from "./jsonc.js";
import {
  createProjectRuntime,
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

/**
 * Node host: bundles `main` with esbuild (as `celld deploy` does) and builds the runtime.
 * `cloudflare:workers` resolves to webrun-cells' module so user classes extend the
 * runtime's own DurableObject / WorkerEntrypoint.
 */
/** Bundles Worker code (a file, or in-memory modules) with the runtime's module mappings, then imports it. */
export async function bundleWorker(
  entry: { path: string } | { modules: Record<string, string>; main: string },
  logs?: LogSink,
  outbound?: typeof fetch,
  opts: { nodeCompat?: boolean } = {},
): Promise<WorkerModule> {
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
  const out = join(mkdtempSync(join(tmpdir(), "cells-worker-")), "worker.mjs");
  const cfWorkers = resolve(import.meta.dirname, "cloudflare-workers.ts");
  const memory = "modules" in entry ? entry.modules : undefined;
  await build({
    entryPoints: [
      memory ? `memory:${(entry as { main: string }).main}` : (entry as { path: string }).path,
    ],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
    inject: [
      resolve(import.meta.dirname, "workers-globals.ts"),
      ...(logs ? ["webrun-cells:console"] : []),
      ...(outbound ? ["webrun-cells:fetch"] : []),
    ],
    plugins: [
      {
        name: "cells-modules",
        setup(b) {
          b.onResolve({ filter: /^webrun-cells:console$/ }, () => ({
            path: "console",
            namespace: "cells-console",
          }));
          // nodejs_compat on a Node host: `node:*` are the real Node.js modules.
          if (opts.nodeCompat)
            b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, external: true }));
          b.onResolve({ filter: /^webrun-cells:fetch$/ }, () => ({
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
            path: cfWorkers,
            external: true,
          }));
          b.onResolve({ filter: /^webrun-cells:ws$/ }, () => ({
            path: resolve(import.meta.dirname, "../ws/server.ts"),
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
  for (const [name, m] of Object.entries(code.modules))
    modules[name] =
      typeof m === "string"
        ? m
        : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
  return (await bundleWorker({ modules, main: code.mainModule }, logs, outbound)) as Record<
    string,
    unknown
  >;
};

export async function loadNodeProject(
  dir: string,
  host: Omit<ProjectHost, "loadModules"> & Partial<Pick<ProjectHost, "loadModules">>,
): Promise<ProjectRuntime & { config: WranglerConfig }> {
  const config = readWranglerConfig(dir);
  if (!config.main && !config.assets)
    throw new Error("wrangler config has neither `main` nor `assets`");
  const nodeCompat = (config.compatibility_flags ?? []).some((f) => f.startsWith("nodejs_compat"));
  const module = config.main
    ? await bundleWorker({ path: resolve(dir, config.main) }, undefined, undefined, { nodeCompat })
    : ({ default: {} } as WorkerModule);
  const assetFiles = config.assets?.directory
    ? readAssetDirectory(resolve(dir, config.assets.directory))
    : undefined;
  return {
    ...createProjectRuntime(config, module, {
      loadModules: nodeModuleLoader,
      isolatedModules: nodeIsolatedLoader(), // loaded Workers in their own realm, as celld
      assetFiles,
      ...host,
    }),
    config,
  };
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
export function nodeIsolatedLoader(): ModuleLoader {
  return isolatedModuleLoader({
    spawn: () => {
      const port = new NodeWorker(new URL(`file://${isolateEntryPathSync()}`));
      port.unref(); // an idle isolate never keeps the process alive
      return { port: port as unknown as PortLike, terminate: () => void port.terminate() };
    },
    prepare: async (_id, code) => {
      await (isolateEntry ??= buildIsolateEntry());
      const modules: Record<string, string> = {};
      for (const [name, m] of Object.entries(code.modules))
        modules[name] =
          typeof m === "string"
            ? m
            : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
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
              b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
                path: resolve(import.meta.dirname, "cloudflare-workers.ts"),
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
