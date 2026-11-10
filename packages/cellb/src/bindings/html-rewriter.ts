/**
 * Workers `HTMLRewriter` on lol-html compiled to WASM: Miniflare's `html-rewriter-wasm`
 * (async handlers via asyncify), vendored as an ES module by scripts/vendor-html-rewriter.mjs.
 * The glue and the WASM are loaded on first use — the WASM from the file system on Node, with
 * fetch() in browsers — so importing the runtime costs nothing until a Worker rewrites HTML.
 * The streaming wrapper follows Miniflare 2's (packages/html-rewriter/src/rewriter.ts).
 */
type Handlers = Record<string, unknown>;
interface RawRewriter {
  on(selector: string, handlers: Handlers): void;
  onDocument(handlers: Handlers): void;
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  free(): void;
}

const wasmUrl = new URL("../../vendor/html-rewriter-wasm/html_rewriter_bg.wasm", import.meta.url);
interface Glue {
  __instantiate(source: unknown): Promise<void>;
  HTMLRewriter: new (sink: (out: Uint8Array) => void, o?: object) => RawRewriter;
}
let ready: Promise<Glue> | undefined;
function instantiate(): Promise<Glue> {
  ready ??= (async () => {
    // @ts-expect-error — generated JS, no declarations
    const glue = (await import("../../vendor/html-rewriter-wasm/html_rewriter.js")).default as Glue;
    let source: unknown;
    if (wasmUrl.protocol === "file:") {
      const fsName = "node:fs"; // not statically visible to browser bundlers
      const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(u: URL): Uint8Array };
      source = fs.readFileSync(wasmUrl);
    } else source = await fetch(wasmUrl);
    await glue.__instantiate(source);
    return glue;
  })();
  return ready;
}

export class HTMLRewriter {
  readonly #elements: [string, Handlers][] = [];
  readonly #documents: Handlers[] = [];

  on(selector: string, handlers: Handlers): this {
    this.#elements.push([selector, handlers]);
    return this;
  }

  onDocument(handlers: Handlers): this {
    this.#documents.push(handlers);
    return this;
  }

  transform(response: Response): Response {
    const body = response.body;
    // No body: the end handler would not run anyway.
    if (body === null) return new Response(null, response);
    let rewriter: RawRewriter | undefined;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      start: async (controller) => {
        const Raw = (await instantiate()).HTMLRewriter;
        rewriter = new Raw(
          (out) => {
            if (out.length !== 0) controller.enqueue(out); // enqueue throws on empty chunks
          },
          { enableEsiTags: false },
        );
        for (const [selector, handlers] of this.#elements) rewriter.on(selector, handlers);
        for (const handlers of this.#documents) rewriter.onDocument(handlers);
      },
      transform: (chunk) =>
        rewriter!.write(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk),
      flush: async () => {
        try {
          await rewriter!.end();
        } finally {
          rewriter!.free();
        }
      },
    });
    const headers = new Headers(response.headers);
    headers.delete("content-length"); // the rewritten body has another length
    return new Response(body.pipeThrough(stream), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
