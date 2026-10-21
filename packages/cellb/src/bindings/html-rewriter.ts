/**
 * Workers `HTMLRewriter` on lol-html compiled to WASM (vendor/htmlrewriter, from the
 * `htmlrewriter` package with an asyncify fix). Loads its WASM from the file system on Node
 * and with fetch() in browsers.
 */
// @ts-expect-error — vendored JS
import init from "../../vendor/htmlrewriter/html_rewriter.js";
// @ts-expect-error — vendored JS
import { HTMLRewriterWrapper } from "../../vendor/htmlrewriter/html_rewriter_wrapper.js";

const wasmUrl = new URL("../../vendor/htmlrewriter/html_rewriter_bg.wasm", import.meta.url);

async function wasmSource(): Promise<unknown> {
  if (wasmUrl.protocol === "file:") {
    const fsName = "node:fs"; // not statically visible to browser bundlers
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(u: URL): Uint8Array };
    return new WebAssembly.Module(fs.readFileSync(wasmUrl) as BufferSource);
  }
  return fetch(wasmUrl);
}

export const HTMLRewriter: new () => {
  on(selector: string, handlers: object): unknown;
  onDocument(handlers: object): unknown;
  transform(response: Response): Response;
} = HTMLRewriterWrapper(lazyInit());

/**
 * The WASM is loaded on first use (a promise-like the wrapper awaits): importing the runtime
 * — in every worker thread, shard worker or page — costs nothing until a Worker uses it.
 */
function lazyInit(): PromiseLike<unknown> {
  let p: Promise<unknown> | undefined;
  return {
    // biome-ignore lint/suspicious/noThenProperty: a deliberate lazy thenable
    then(onOk, onErr) {
      p ??= wasmSource().then((src) => init(src));
      return p.then(onOk, onErr);
    },
  };
}
