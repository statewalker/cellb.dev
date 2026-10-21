import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { LogSink, ModuleLoader } from "../bindings/worker-loader.js";
import type { WorkerModule } from "../core/runtime.js";
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
): Promise<WorkerModule> {
  // Loaded code gets a bundle-local `console` that also feeds its Tail Workers.
  const consoleKey = logs ? `c${Math.random().toString(36).slice(2)}` : "";
  if (logs) {
    const registry = ((globalThis as Record<string, unknown>).__cellsConsoles ??= {}) as Record<
      string,
      unknown
    >;
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
    ],
    plugins: [
      {
        name: "cells-modules",
        setup(b) {
          b.onResolve({ filter: /^webrun-cells:console$/ }, () => ({
            path: "console",
            namespace: "cells-console",
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
  const modules: Record<string, string> = {};
  for (const [name, m] of Object.entries(code.modules))
    modules[name] =
      typeof m === "string"
        ? m
        : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
  return (await bundleWorker({ modules, main: code.mainModule }, logs)) as Record<string, unknown>;
};

export async function loadNodeProject(
  dir: string,
  host: Omit<ProjectHost, "loadModules"> & Partial<Pick<ProjectHost, "loadModules">>,
): Promise<ProjectRuntime & { config: WranglerConfig }> {
  const config = readWranglerConfig(dir);
  if (!config.main) throw new Error("wrangler config has no `main`");
  const module = await bundleWorker({ path: resolve(dir, config.main) });
  return {
    ...createProjectRuntime(config, module, { loadModules: nodeModuleLoader, ...host }),
    config,
  };
}
