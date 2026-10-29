/// <reference lib="webworker" />
// Builds the Astro app in this worker: esbuild-wasm, Astro's compiler (wasm, from npm), and
// webrun-bundler with packages from the npm registry. Receives the sources as { path: bytes },
// answers { code } or { error }, and posts { log } lines on the way.
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import * as esbuild from "esbuild-wasm/esm/browser.js";
import { buildAstroApp } from "../src/builder/build.ts";
import { loadAstroCompiler } from "./compiler.ts";

const log = (line: string) => postMessage({ log: line });

self.onmessage = async (e: MessageEvent<{ sources: Record<string, Uint8Array> }>) => {
  try {
    const t0 = performance.now();
    await esbuild.initialize({ wasmURL, worker: false });
    log(`esbuild-wasm ${esbuild.version} ready`);
    const transform = await loadAstroCompiler();
    log("Astro's compiler (compiler-rs wasm, from npm) ready");
    const files = new MemFilesApi();
    for (const [path, bytes] of Object.entries(e.data.sources)) await files.write(path, [bytes]);
    const built = await buildAstroApp({
      esbuild,
      transform,
      files,
      root: "/app",
      packages: npmPackages(),
      log,
    });
    log(
      `built in ${Math.round(performance.now() - t0)} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.inputs.length} inputs`,
    );
    postMessage({
      code: built.code,
      routes: built.routes.map((r) => r.route),
      inputs: built.inputs.length,
    });
  } catch (err) {
    postMessage({ error: (err as Error)?.stack ?? String(err) });
  }
};
