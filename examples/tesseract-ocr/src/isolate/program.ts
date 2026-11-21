// The OCR isolate: decoding and tesseract-wasm in a Worker Loader isolate of their own. The
// cell (src/ocr-cell.ts) loads it with tesseract-core.wasm fetched from WASM_URL, so the cell's
// isolate holds neither the engine's wasm memory nor decoded pixels, and a crash or an
// out-of-memory here leaves the cell running. scripts/build-isolate.mjs bundles this file into
// src/isolate/program.gen.js (the code and the wasm's SHA-256).
import { WorkerEntrypoint } from "cloudflare:workers";
import { type RawImage, toSource } from "../decode.ts";
import {
  createEngine,
  type Engine,
  type RecognizeOptions,
  recognize,
  wasmMemoryBytes,
} from "../ocr.ts";
import tesseractWasm from "./tesseract-core.wasm";

const engines = new Map<string, Promise<Engine>>();

export default class OcrIsolate extends WorkerEntrypoint {
  /** Languages whose engine is loaded here. */
  async languages(): Promise<string[]> {
    return [...engines.keys()];
  }

  /** Creates the engine for `lang` with the given model (once per isolate and language). */
  async load(lang: string, model: Uint8Array): Promise<void> {
    if (engines.has(lang)) return;
    const engine = createEngine(tesseractWasm, model);
    engines.set(lang, engine);
    engine.catch(() => engines.delete(lang));
    await engine;
  }

  async ocr(lang: string, image: ArrayBuffer | RawImage, options: RecognizeOptions) {
    const engine = engines.get(lang);
    if (!engine) throw new Error(`ENOENT: no engine for '${lang}' in this isolate`);
    const ready = await engine;
    const source = toSource(image);
    const result = recognize(ready, source, options);
    return {
      ...result,
      wasmMemoryBytes: wasmMemoryBytes(ready),
      decodedBytes: source.bytes,
    };
  }
}
