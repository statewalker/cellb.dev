/**
 * Tesseract OCR on a decoded image, with tesseract-wasm. Runs wherever the
 * wasm arrives as a compiled module: in a Durable Object (a `.wasm` import of
 * the Worker) or in a Worker Loader isolate (a `{ wasm }` module).
 */
import { createOCREngine, layoutFlags, type OCREngine } from "tesseract-wasm";
import type { PixelSource } from "./decode.ts";
import { type WasmProbe, withPrecompiledWasm } from "./wasm-shim.ts";

export type OcrWord = {
  text: string;
  /** In [0, 1]. */
  confidence: number;
  /** In pixels of the image. */
  bbox: { x: number; y: number; width: number; height: number };
  startOfLine: boolean;
  endOfLine: boolean;
};

export type OcrResult = {
  width: number;
  height: number;
  words: OcrWord[];
  text: string;
  meanConfidence: number;
};

export type Engine = { engine: OCREngine; probe: WasmProbe };

/** Bytes the library is handed as `wasmBinary`: any will do, the shim answers from the module. */
const PLACEHOLDER = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

export async function createEngine(wasm: WebAssembly.Module, model: Uint8Array): Promise<Engine> {
  const probe: WasmProbe = {};
  const engine = await withPrecompiledWasm(wasm, probe, () =>
    createOCREngine({ wasmBinary: PLACEHOLDER }),
  );
  engine.loadModel(model);
  return { engine, probe };
}

export type RecognizeOptions = {
  /**
   * Rows per band; 0 reads the image in one go. Tesseract's memory grows with
   * the pixels it is given (and wasm memory never shrinks), so large pages are
   * read band by band. Default: as many rows as fit in `bandPixels`.
   */
  bandHeight?: number;
  /** Pixels per band when `bandHeight` is not given. */
  bandPixels?: number;
  /** Rows read above and below each band, so lines cut by its edge are read whole. */
  overlap?: number;
};

export const DEFAULT_BAND_PIXELS = 3_000_000;
export const DEFAULT_OVERLAP = 120;
/** The thinnest band a caller may ask for. */
export const MIN_BAND_ROWS = 256;

/**
 * Recognises the image band by band. A word is kept from the band whose core
 * (the band without its overlap) contains the word's vertical centre: a line
 * across a band edge is read whole by one band and not repeated by the next.
 */
export function recognize(
  { engine }: Engine,
  source: PixelSource,
  options: RecognizeOptions = {},
): OcrResult & { bands: number } {
  const { width, height } = source;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  if (options.bandHeight !== undefined && options.bandHeight !== 0) {
    // Thin bands mean one recognition per few rows: minutes of CPU in the cell. Whole rows only.
    if (!Number.isInteger(options.bandHeight) || options.bandHeight < MIN_BAND_ROWS)
      throw new Error(`EINVAL: band is 0 or a whole number of rows ≥ ${MIN_BAND_ROWS}`);
  }
  const bandHeight =
    options.bandHeight === 0
      ? height
      : (options.bandHeight ??
        Math.max(4 * overlap, Math.floor((options.bandPixels ?? DEFAULT_BAND_PIXELS) / width)));
  const words: OcrWord[] = [];
  let bands = 0;
  for (let core = 0; core < height; core += bandHeight) {
    const coreEnd = Math.min(height, core + bandHeight);
    const top = Math.max(0, core - overlap);
    const bottom = Math.min(height, coreEnd + overlap);
    bands++;
    // Typed as DOM ImageData by the library; a plain { data, width, height } is what it reads.
    engine.loadImage(source.rows(top, bottom) as never);
    try {
      for (const i of engine.getTextBoxes("word")) {
        if (i.text.trim() === "") continue;
        const centre = top + (i.rect.top + i.rect.bottom) / 2;
        if (centre < core || centre >= coreEnd) continue;
        words.push({
          text: i.text,
          confidence: Math.round(i.confidence * 1000) / 1000,
          bbox: {
            x: i.rect.left,
            y: top + i.rect.top,
            width: i.rect.right - i.rect.left,
            height: i.rect.bottom - i.rect.top,
          },
          startOfLine: (i.flags & layoutFlags.StartOfLine) !== 0,
          endOfLine: (i.flags & layoutFlags.EndOfLine) !== 0,
        });
      }
    } finally {
      engine.clearImage();
    }
  }
  let text = "";
  for (const w of words) text += w.text + (w.endOfLine ? "\n" : " ");
  const meanConfidence =
    words.length === 0 ? 0 : words.reduce((s, w) => s + w.confidence, 0) / words.length;
  return {
    width,
    height,
    words,
    text: text.trim(),
    meanConfidence: Math.round(meanConfidence * 1000) / 1000,
    bands,
  };
}

/** Size of the engine's linear memory (it only grows: wasm memory cannot shrink). */
export const wasmMemoryBytes = ({ probe }: Engine) => probe.memory?.buffer.byteLength ?? 0;
