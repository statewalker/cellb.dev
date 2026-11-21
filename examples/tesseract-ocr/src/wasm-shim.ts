/**
 * workerd refuses to compile WebAssembly from bytes at runtime
 * (`WebAssembly.compile`, `instantiate(buffer)`): wasm has to arrive as a
 * module of the Worker (a `.wasm` import is a compiled `WebAssembly.Module`)
 * or of a Worker Loader isolate (`{ wasm: bytes }`).
 *
 * tesseract-wasm's Emscripten glue only knows `WebAssembly.instantiate(bytes,
 * imports)`. While `fn` runs, that call is answered from the precompiled
 * module instead, so the library works unmodified (and `URL` tolerates a base
 * it cannot resolve against, below). The linear memory the
 * instance exports is recorded, to report how much memory OCR takes.
 */

export type WasmProbe = { memory?: WebAssembly.Memory };

export async function withPrecompiledWasm<T>(
  module: WebAssembly.Module,
  probe: WasmProbe,
  fn: () => Promise<T>,
): Promise<T> {
  const original = WebAssembly.instantiate;
  const patched = (async (source: unknown, imports?: WebAssembly.Imports) => {
    if (source instanceof WebAssembly.Module) return original(source, imports);
    // Bytes (the library's `wasmBinary`): instantiate the precompiled module instead,
    // shaped like instantiate(bytes)'s result.
    const instance = await original(module, imports);
    for (const value of Object.values(instance.exports)) {
      if (value instanceof WebAssembly.Memory) probe.memory = value;
    }
    return { module, instance };
  }) as typeof WebAssembly.instantiate;
  WebAssembly.instantiate = patched;
  const scope = globalThis as unknown as { URL: typeof URL };
  const OriginalURL = scope.URL;
  scope.URL = UrlWithFallbackBase;
  try {
    return await fn();
  } finally {
    WebAssembly.instantiate = original;
    scope.URL = OriginalURL;
  }
}

/**
 * The Emscripten glue also computes `new URL("tesseract-core.wasm", import.meta.url)` (the URL
 * is never fetched: the wasm comes as a module). Where the bundle runs from a `blob:` URL (cellb
 * in a browser) that base cannot resolve a relative URL and the constructor throws; workerd
 * needs a wrangler `define` for it, which `cellb build` does not apply. While an engine is
 * created, such a URL resolves against a placeholder `file:` base instead.
 */
const NativeURL = URL;
const resolves = (url: string | URL, base: string | URL) => {
  try {
    new NativeURL(url, base);
    return true;
  } catch {
    return false;
  }
};

class UrlWithFallbackBase extends NativeURL {
  constructor(url: string | URL, base?: string | URL) {
    super(url, base === undefined || resolves(url, base) ? base : "file:///tesseract-wasm/");
  }
}

const MARKER = "\0precompiled-wasm:";
const markerPrefix = new TextEncoder().encode(MARKER);
const registry = new Map<string, WebAssembly.Module>();
let installed = false;

function markerName(source: unknown): string | null {
  const bytes =
    source instanceof Uint8Array
      ? source
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : ArrayBuffer.isView(source)
          ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
          : null;
  if (!bytes || bytes.length <= markerPrefix.length) return null;
  for (let i = 0; i < markerPrefix.length; i++) if (bytes[i] !== markerPrefix[i]) return null;
  return new TextDecoder().decode(bytes.subarray(markerPrefix.length));
}

/**
 * For libraries that fetch their wasm and instantiate the bytes (pdf.js's JBIG2, JPEG 2000 and
 * ICC decoders): `markerFor(name)` gives bytes to hand them instead of the file, and
 * `WebAssembly.instantiate` answers those bytes from the precompiled module registered under
 * `name`. Any other call goes to the runtime unchanged. Installed once per isolate.
 */
export function registerPrecompiledWasm(modules: Record<string, WebAssembly.Module>) {
  for (const [name, module] of Object.entries(modules)) registry.set(name, module);
  if (!installed) {
    installed = true;
    const original = WebAssembly.instantiate;
    WebAssembly.instantiate = (async (source: unknown, imports?: WebAssembly.Imports) => {
      const name = markerName(source);
      const module = name === null ? undefined : registry.get(name);
      if (!module)
        return (original as (s: unknown, i?: WebAssembly.Imports) => unknown)(source, imports);
      return { module, instance: await original(module, imports) };
    }) as typeof WebAssembly.instantiate;
  }
  return {
    markerFor: (name: string) => new TextEncoder().encode(MARKER + name),
    has: (name: string) => registry.has(name),
  };
}
