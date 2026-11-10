/**
 * WebAssembly the platform needs, injected by the entry module. workerd (Wrangler, Cloudflare)
 * and celld forbid compiling WebAssembly from bytes at run time, so the entry imports the `.wasm`
 * files as modules (`import m from "esbuild-wasm/esbuild.wasm"`); for cellb, whose project bundler
 * has no `.wasm` loader, `scripts/build-cellb.mjs` turns those imports into modules compiled
 * from embedded bytes. Either way the platform code receives `WebAssembly.Module`s here.
 */
import * as esbuildWasm from "esbuild-wasm/esm/browser.js";
import initLightningCss from "lightningcss-wasm";

type Wasm = WebAssembly.Module | Promise<WebAssembly.Module>;
const modules: { esbuild?: Wasm; lightningcss?: Wasm } = {};

export function provideWasm(m: { esbuild?: Wasm; lightningcss?: Wasm }) {
  Object.assign(modules, m);
}

/** Whether lightningcss.wasm was provided (else CSS is served without processing). */
export const hasLightningCss = () => !!modules.lightningcss;

export type EsbuildApi = typeof esbuildWasm;
let esbuildReady: Promise<EsbuildApi> | undefined;

/** esbuild-wasm, initialized in this realm (no worker thread: a Worker isolate has none). */
export function getEsbuild(): Promise<EsbuildApi> {
  esbuildReady ??= (async () => {
    if (!modules.esbuild) throw new Error("esbuild.wasm was not provided by the entry module");
    // esbuild-wasm's browser build reads `self`, which a Node realm (cellb on Node) lacks.
    (globalThis as { self?: unknown }).self ??= globalThis;
    await esbuildWasm.initialize({ wasmModule: await modules.esbuild, worker: false });
    return esbuildWasm;
  })();
  return esbuildReady;
}

let cssReady: Promise<void> | undefined;

/**
 * Initializes lightningcss-wasm before webrun-modules' CSS transform calls its `init()`:
 * that call then returns at once instead of fetching the `.wasm` by URL.
 */
export function ensureLightningCss(): Promise<void> {
  cssReady ??= (async () => {
    if (!modules.lightningcss) return;
    const m = await modules.lightningcss;
    await initLightningCss(Promise.resolve(m) as never);
  })();
  return cssReady;
}
