/**
 * Node side of the browser conformance run: bundles a project's `main` for a browser realm
 * (what `celld deploy` uploads) and collects its config and asset files. The bundle reads
 * `cloudflare:workers` and the Workers globals (`Response` with status 101, `WebSocketPair`)
 * from host registries set by the browser runtime — the ~deps idea, done at bundle time.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { NODE_POLYFILL_FILES, NODE_POLYFILL_PACKAGES } from "../src/node-compat/modules.ts";
import { readAssetDirectory, readWranglerConfig } from "../src/project/node-project.ts";
import { SCHEDULER_EXPRESSION } from "../src/project/scheduler.ts";
import type { WranglerConfig } from "../src/project/wrangler.ts";
import { projectDir } from "./projects.ts";

const app = resolve(import.meta.dirname, "..");
const requireFromApp = createRequire(resolve(app, "package.json"));

export interface BrowserProject {
  name: string;
  config: WranglerConfig;
  code: string | null;
  assets: [string, string][]; // path, base64
}

export const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";
const GLOBALS_SHIM = `export const Response = globalThis.__cellsGlobals.Response; export const WebSocketPair = globalThis.__cellsGlobals.WebSocketPair; export const caches = globalThis.__cellsGlobals.caches; export const HTMLRewriter = globalThis.__cellsGlobals.HTMLRewriter; export const WebSocketRequestResponsePair = globalThis.__cellsGlobals.WebSocketRequestResponsePair; export const scheduler = ${SCHEDULER_EXPRESSION};`;

export async function bundleProjectForBrowser(name: string): Promise<BrowserProject> {
  const dir = projectDir(name);
  const config = readWranglerConfig(dir);
  let code: string | null = null;
  const nodeCompat = (config.compatibility_flags ?? []).some((f) => f.startsWith("nodejs_compat"));
  if (config.main) {
    const out = await build({
      entryPoints: [resolve(dir, config.main)],
      write: false,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      inject: [
        "cells:globals",
        ...(nodeCompat ? [resolve(app, "src/node-compat/globals.ts")] : []),
      ],
      plugins: [
        {
          name: "cells-browser",
          setup(b) {
            // nodejs_compat: node:* → browser polyfills, bundled in.
            if (nodeCompat)
              b.onResolve({ filter: /^node:/ }, (a) => {
                const file = NODE_POLYFILL_FILES[a.path];
                if (file) return { path: resolve(app, "src/node-compat", file) };
                const pkg = NODE_POLYFILL_PACKAGES[a.path];
                // "buffer/" (trailing slash): the npm package, not the Node.js built-in of that name
                if (pkg) return { path: requireFromApp.resolve(`${pkg}/`) };
                return {
                  errors: [{ text: `${a.path} is not available in browsers (nodejs_compat)` }],
                };
              });
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
