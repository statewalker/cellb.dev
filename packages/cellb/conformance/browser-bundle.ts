/**
 * Node side of the browser conformance run: bundles a project's `main` for a browser realm
 * (what `celld deploy` uploads) and collects its config and asset files. The bundle reads
 * `cloudflare:workers` and the Workers globals (`Response` with status 101, `WebSocketPair`)
 * from host registries set by the browser runtime — the ~deps idea, done at bundle time.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { readAssetDirectory, readWranglerConfig } from "../src/project/node-project.ts";
import type { WranglerConfig } from "../src/project/wrangler.ts";
import { projectDir } from "./projects.ts";

export interface BrowserProject {
  name: string;
  config: WranglerConfig;
  code: string | null;
  assets: [string, string][]; // path, base64
}

export const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";
const GLOBALS_SHIM =
  "export const Response = globalThis.__cellsGlobals.Response; export const WebSocketPair = globalThis.__cellsGlobals.WebSocketPair; export const caches = globalThis.__cellsGlobals.caches;";

export async function bundleProjectForBrowser(name: string): Promise<BrowserProject> {
  const dir = projectDir(name);
  const config = readWranglerConfig(dir);
  let code: string | null = null;
  if (config.main) {
    const out = await build({
      entryPoints: [resolve(dir, config.main)],
      write: false,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      inject: ["cells:globals"],
      plugins: [
        {
          name: "cells-browser",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$|^cells:globals$/ }, (a) => ({
              path: a.path,
              namespace: "cells",
            }));
            b.onLoad({ filter: /.*/, namespace: "cells" }, (a) => ({
              contents: a.path === "cloudflare:workers" ? WORKERS_MODULE_SHIM : GLOBALS_SHIM,
              loader: "js",
            }));
          },
        },
      ],
    });
    code = out.outputFiles[0].text;
  }
  const assets: [string, string][] = [];
  if (config.assets?.directory)
    for (const [p, bytes] of readAssetDirectory(resolve(dir, config.assets.directory)))
      assets.push([p, Buffer.from(bytes).toString("base64")]);
  void readFileSync;
  return { name, config, code, assets };
}

/** All files of a project (sources, config, assets) as [path, base64] — what a site serves. */
export function readProjectFiles(name: string): [string, string][] {
  return [...readAssetDirectory(projectDir(name))].map(([p, bytes]) => [
    p,
    Buffer.from(bytes).toString("base64"),
  ]);
}

/** What the in-browser HTTP server needs: config, all files (served as-is), assets. */
export function projectForSite(name: string) {
  const dir = projectDir(name);
  const config = readWranglerConfig(dir);
  const assets: [string, string][] = config.assets?.directory
    ? [...readAssetDirectory(resolve(dir, config.assets.directory))].map(([p, b]) => [
        p,
        Buffer.from(b).toString("base64"),
      ])
    : [];
  return { name, config, files: readProjectFiles(name), assets };
}
