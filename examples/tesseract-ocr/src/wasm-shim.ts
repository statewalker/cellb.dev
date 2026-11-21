/**
 * workerd refuses to compile WebAssembly from bytes at runtime
 * (`WebAssembly.compile`, `instantiate(buffer)`): wasm has to arrive as a
 * module of the Worker (a `.wasm` import is a compiled `WebAssembly.Module`)
 * or of a Worker Loader isolate (`{ wasm: bytes }`).
 *
 * tesseract-wasm's Emscripten glue only knows `WebAssembly.instantiate(bytes,
 * imports)`. It is handed marker bytes as `wasmBinary`, and that call is
 * answered from the precompiled module instead, so the library works
 * unmodified (and `URL` tolerates a base it cannot resolve against, below). The linear memory the
 * instance exports is recorded, to report how much memory OCR takes.
 */

export type WasmProbe = { memory?: WebAssembly.Memory };

let nextCall = 0;

/**
 * Creates an engine with `fn`, handing it bytes to pass as the library's `wasmBinary`: marker
 * bytes, which the permanent marker-keyed `WebAssembly.instantiate` (below) answers with the
 * precompiled `module`, recording that instance's memory in `probe`. Nothing global is swapped
 * across an await, so engines created at the same time (cells of one isolate) cannot leave a
 * patch behind. The glue's URL (below) is computed synchronously within `fn`'s call, so `URL` is
 * replaced only during that call.
 */
export async function withPrecompiledWasm<T>(
  module: WebAssembly.Module,
  probe: WasmProbe,
  fn: (wasmBinary: Uint8Array) => Promise<T>,
): Promise<T> {
  const name = `engine-${++nextCall}`;
  const { markerFor } = registerPrecompiledWasm({
    [name]: {
      module,
      once: true,
      onInstance(instance) {
        for (const value of Object.values(instance.exports))
          if (value instanceof WebAssembly.Memory) probe.memory = value;
      },
    },
  });
  const scope = globalThis as unknown as { URL: typeof URL };
  const OriginalURL = scope.URL;
  scope.URL = UrlWithFallbackBase;
  let created: Promise<T>;
  try {
    created = fn(markerFor(name));
  } finally {
    scope.URL = OriginalURL;
  }
  try {
    return await created;
  } finally {
    unregister(name);
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

  /** While it stands in for `URL`, a native URL is still `instanceof URL`. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof NativeURL;
  }
}

const MARKER = "\0precompiled-wasm:";
const markerPrefix = new TextEncoder().encode(MARKER);
type Entry = {
  module: WebAssembly.Module;
  /** Called with each instance made from the marker. */
  onInstance?: (instance: WebAssembly.Instance) => void;
  /** Answered once, then forgotten (a marker per engine). */
  once?: boolean;
};
const registry = new Map<string, Entry>();
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

const unregister = (name: string) => registry.delete(name);

/**
 * For libraries that fetch their wasm and instantiate the bytes (pdf.js's JBIG2, JPEG 2000 and
 * ICC decoders, and tesseract-wasm through `withPrecompiledWasm`): `markerFor(name)` gives bytes
 * to hand them instead of the file, and `WebAssembly.instantiate` answers those bytes from the
 * precompiled module registered under `name`. Any other call goes to the runtime unchanged.
 * Installed once per realm, and never removed.
 */
export function registerPrecompiledWasm(modules: Record<string, WebAssembly.Module | Entry>) {
  for (const [name, entry] of Object.entries(modules))
    registry.set(name, entry instanceof WebAssembly.Module ? { module: entry } : entry);
  if (!installed) {
    installed = true;
    const original = WebAssembly.instantiate;
    WebAssembly.instantiate = (async (source: unknown, imports?: WebAssembly.Imports) => {
      const name = markerName(source);
      const entry = name === null ? undefined : registry.get(name);
      if (!entry || name === null)
        return (original as (s: unknown, i?: WebAssembly.Imports) => unknown)(source, imports);
      if (entry.once) registry.delete(name);
      const instance = await original(entry.module, imports);
      entry.onInstance?.(instance);
      return { module: entry.module, instance };
    }) as typeof WebAssembly.instantiate;
  }
  return {
    markerFor: (name: string) => new TextEncoder().encode(MARKER + name),
    has: (name: string) => registry.has(name),
  };
}
