/// <reference lib="webworker" />
// Builds an Astro app in this worker: esbuild-wasm, Astro's compiler (wasm, from npm), and
// webrun-bundler with packages from the npm registry. Receives { sources: { path: bytes },
// integrations?: boolean } and answers { code, clientAssets } or { error }, posting { log } on
// the way. With `integrations`, astro.config.mjs and its integrations run first (EmDash), and
// the Worker is built for cellb's runtime (its node:* polyfills, cloudflare:workers, globals).
import "./process-shim.ts";
import { CELLS_GLOBALS_MODULE, cellbHostModule } from "@statewalker/cellb/host-modules";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import * as esbuild from "esbuild-wasm/esm/browser.js";
import { buildAstroApp } from "../src/builder/build.ts";
import { preloadVfs, runAstroConfig } from "../src/builder/integrations.ts";
import { loadAstroCompiler } from "./compiler.ts";

const log = (line: string) => postMessage({ log: line });

self.onmessage = async (
  e: MessageEvent<{ sources: Record<string, Uint8Array>; integrations?: boolean }>,
) => {
  try {
    const t0 = performance.now();
    await esbuild.initialize({ wasmURL, worker: false });
    log(`esbuild-wasm ${esbuild.version} ready`);
    const transform = await loadAstroCompiler();
    log("Astro's compiler (compiler-rs wasm, from npm) ready");
    const files = new MemFilesApi();
    for (const [path, bytes] of Object.entries(e.data.sources)) await files.write(path, [bytes]);
    const packages = npmPackages();
    let extra = {};
    if (e.data.integrations) {
      log("preloading the packages integrations read at build time…");
      const { vfs, mounts } = await preloadVfs(files, "/app", packages, [
        ["emdash"],
        ["@emdash-cms/admin", "emdash"],
        ["astro"],
      ]);
      log(`build-time file system: ${vfs.size} files`);
      const integration = await runAstroConfig({
        esbuild,
        files,
        root: "/app",
        packages,
        vfs,
        log,
        evaluate: async (code) => {
          const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
          try {
            return await import(/* @vite-ignore */ url);
          } finally {
            URL.revokeObjectURL(url);
          }
        },
      });
      log(
        `integrations: ${integration.routes.length} routes, ${integration.middleware.length} middleware, plugins ${integration.plugins.map((p) => p.name).join(", ")}`,
      );
      extra = {
        integration,
        nodeMounts: mounts,
        hostModules: cellbHostModule,
        inject: [CELLS_GLOBALS_MODULE],
        session: {
          driver: "unstorage/drivers/cloudflare-kv-binding",
          options: { binding: "SESSION" },
        },
      };
    }
    const built = await buildAstroApp({
      esbuild,
      transform,
      files,
      root: "/app",
      packages,
      log,
      ...extra,
    });
    log(
      `built in ${Math.round(performance.now() - t0)} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.inputs.length} inputs`,
    );
    postMessage({
      code: built.code,
      routes: built.routes.length,
      clientAssets: built.clientAssets,
    });
  } catch (err) {
    postMessage({ error: (err as Error)?.stack ?? String(err) });
  }
};
