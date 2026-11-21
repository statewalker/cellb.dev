/**
 * The cell's side of OCR in a Worker Loader isolate (src/isolate/program.ts). The isolate's
 * code is embedded (about 90 KB); tesseract-core.wasm (about 1.8 MB) is fetched once per cell
 * isolate from WASM_URL and must match the SHA-256 the code was built for.
 *
 * An isolate is kept per language while it answers; a call that fails other than by its request
 * (a crash, an out-of-memory) retires it, and the next call loads a fresh one. The Worker
 * Loader has no terminate: a retired isolate runs until its runtime ends it.
 */

import type { RawImage } from "./decode.ts";
import program from "./isolate/program.gen.js";
import type { RecognizeOptions } from "./ocr.ts";

/** The part of the Worker Loader binding used here. */
interface Loader {
  get(
    id: string,
    code: () => Promise<{
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string | { wasm: Uint8Array }>;
      env: Record<string, unknown>;
      globalOutbound: null;
    }>,
  ): { getEntrypoint(): unknown };
}

interface OcrIsolate {
  languages(): Promise<string[]>;
  load(lang: string, model: Uint8Array): Promise<void>;
  ocr(
    lang: string,
    image: ArrayBuffer | RawImage,
    options: RecognizeOptions,
  ): Promise<
    import("./ocr.ts").OcrResult & { bands: number; wasmMemoryBytes: number; decodedBytes: number }
  >;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_WASM_BYTES = 8 * 1024 * 1024;

let wasm: Promise<Uint8Array> | undefined;
const generations = new Map<string, number>();

async function fetchWasm(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`EIO: tesseract-core.wasm: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_WASM_BYTES) throw new Error("EIO: tesseract-core.wasm is too large");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== program.wasmSha256)
    throw new Error(
      `EIO: tesseract-core.wasm does not match tesseract-wasm ${program.tesseractVersion} (sha256 ${hex})`,
    );
  return bytes;
}

export const isolateOffered = (env: { LOADER?: unknown; WASM_URL?: string }) =>
  !!env.LOADER && !!env.WASM_URL;

/**
 * Runs OCR for `lang` in the language's isolate. `model` is asked for only when the isolate
 * has no engine for the language yet (a new or recycled isolate).
 */
export async function ocrInIsolate(
  env: { LOADER?: unknown; WASM_URL?: string },
  scope: string,
  lang: string,
  image: ArrayBuffer | RawImage,
  options: RecognizeOptions,
  model: () => Promise<Uint8Array>,
) {
  if (!env.LOADER) throw new Error("ENOSYS: OCR isolates need a Worker Loader binding (LOADER)");
  const url = env.WASM_URL;
  if (!url) throw new Error("ENOSYS: no WASM_URL for OCR isolates");
  wasm ??= fetchWasm(url).catch((e) => {
    wasm = undefined;
    throw e;
  });
  const bytes = await wasm;
  const key = `${scope}/${lang}`;
  const generation = generations.get(key) ?? 0;
  const id = `ocr-${key}-${program.wasmSha256.slice(0, 12)}-${generation}`;
  const isolate = (env.LOADER as Loader)
    .get(id, async () => ({
      compatibilityDate: "2026-10-01",
      mainModule: "ocr.js",
      modules: { "ocr.js": program.code, "tesseract-core.wasm": { wasm: bytes } },
      env: {},
      globalOutbound: null,
    }))
    .getEntrypoint() as unknown as OcrIsolate;
  try {
    let modelSent = false;
    if (!(await isolate.languages()).includes(lang)) {
      await isolate.load(lang, await model());
      modelSent = true;
    }
    return { ...(await isolate.ocr(lang, image, options)), modelSent, isolateId: id };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // The request's own errors (a bad image) keep the isolate; anything else retires it.
    if (!/^(Error: )?(EINVAL|E2BIG)/.test(message)) generations.set(key, generation + 1);
    throw e;
  }
}
