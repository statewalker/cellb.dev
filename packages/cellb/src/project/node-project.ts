import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { WorkerModule } from "../core/runtime.js";
import { parseJsonc } from "./jsonc.js";
import { createProjectRuntime, type ProjectHost, type ProjectRuntime, type WranglerConfig } from "./wrangler.js";

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
export async function loadNodeProject(dir: string, host: ProjectHost): Promise<ProjectRuntime & { config: WranglerConfig }> {
  const config = readWranglerConfig(dir);
  if (!config.main) throw new Error("wrangler config has no `main`");
  const out = join(mkdtempSync(join(tmpdir(), "cells-project-")), "worker.mjs");
  const cfWorkers = resolve(import.meta.dirname, "cloudflare-workers.ts");
  await build({
    entryPoints: [resolve(dir, config.main)],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "cloudflare-workers",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: cfWorkers, external: true }));
        },
      },
    ],
  });
  const module = (await import(/* @vite-ignore */ out)) as WorkerModule;
  return { ...createProjectRuntime(config, module, host), config };
}
