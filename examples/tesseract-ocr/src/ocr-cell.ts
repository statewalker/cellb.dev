/**
 * One OCR cell: a Durable Object holding a tesseract-wasm engine. The engine
 * (wasm instance plus the language model) stays in memory between requests;
 * the model also survives restarts in the cell's SQLite. Cells are named per
 * language by the Worker (`ocr-<lang>`), mirroring the browser's one worker
 * per language: each holds one model, and different languages run in
 * different cells, in parallel.
 *
 * Requests to one cell run one at a time: recognition is synchronous
 * compute, so the cell's input gate holds the next request until it ends.
 */
import { DurableObject } from "cloudflare:workers";
import tesseractWasm from "../node_modules/tesseract-wasm/dist/tesseract-core.wasm";
import { type RawImage, toSource } from "./decode.ts";
import { isolateOffered, ocrInIsolate } from "./isolate-client.ts";
import {
  checkLang,
  initModelTable,
  loadModel,
  type ModelSource,
  type Sql,
  storedModels,
} from "./models.ts";
import {
  createEngine,
  type Engine,
  type OcrResult,
  type RecognizeOptions,
  recognize,
  wasmMemoryBytes,
} from "./ocr.ts";

export interface Env {
  OCR: DurableObjectNamespace<OcrCell>;
  PDF_JOB: DurableObjectNamespace<import("./pdf/pdf-job.ts").PdfJob>;
  LOADER?: unknown;
  /** Directory URL of `<lang>.traineddata` files. */
  MODEL_BASE_URL?: string;
  /** Where tesseract-core.wasm is, for OCR in Worker Loader isolates (`engine: "isolate"`). */
  WASM_URL?: string;
}

/** Where recognition runs: in the cell's own isolate, or in a Worker Loader isolate. */
export type OcrEngineKind = "cell" | "isolate";

export const DEFAULT_MODEL_BASE_URL =
  "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/";

export type CellOcrResult = OcrResult & {
  lang: string;
  engine: OcrEngineKind;
  /** For `engine: "isolate"`: the isolate's id, and whether the model had to be sent to it. */
  isolate?: { id: string; modelSent: boolean };
  cell: { bootId: string; requests: number };
  model: { source: ModelSource; bytes: number };
  /** Bands the image was read in. */
  bands: number;
  /** Linear memory of the wasm instance after this run, in MiB (it never shrinks). */
  wasmMemoryMiB: number;
  /** The compact decoded image held in JS during the run, in MiB. */
  decodedMiB: number;
};

// Generated on first use: workerd refuses random values at global scope.
let bootIdValue: string | undefined;
const bootId = () => {
  bootIdValue ??= crypto.randomUUID();
  return bootIdValue;
};
const mib = (n: number) => Math.round((n / 2 ** 20) * 10) / 10;

export class OcrCell extends DurableObject<Env> {
  readonly #sql: Sql;
  readonly #engines = new Map<string, Promise<Engine>>();
  readonly #modelBytes = new Map<string, number>();
  #requests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql as unknown as Sql;
    initModelTable(this.#sql);
  }

  /** OCR of an encoded image (PNG, JPEG) or of raw pixels (e.g. pdf.js's, see `RawImage`). */
  async ocr(
    image: ArrayBuffer | RawImage,
    lang: string,
    options: RecognizeOptions & { engine?: OcrEngineKind } = {},
  ): Promise<CellOcrResult> {
    checkLang(lang);
    this.#requests++;
    if (options.engine === "isolate") return this.#ocrInIsolate(image, lang, options);
    let modelSource: ModelSource = "memory";
    let engine = this.#engines.get(lang);
    if (!engine) {
      engine = (async () => {
        const base = this.env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL;
        const model = await loadModel(this.#sql, lang, base);
        modelSource = model.source;
        this.#modelBytes.set(lang, model.bytes.byteLength);
        return createEngine(tesseractWasm, model.bytes);
      })();
      this.#engines.set(lang, engine);
      engine.catch(() => this.#engines.delete(lang));
    }
    const ready = await engine;
    const source = toSource(image);
    const result = recognize(ready, source, options);
    return {
      ...result,
      lang,
      engine: "cell",
      cell: { bootId: bootId(), requests: this.#requests },
      model: { source: modelSource, bytes: this.#modelBytes.get(lang) ?? 0 },
      wasmMemoryMiB: mib(wasmMemoryBytes(ready)),
      decodedMiB: mib(source.bytes),
    };
  }

  /**
   * OCR in a Worker Loader isolate: the cell keeps only the encoded image and, while sending
   * it, the model; decoding and tesseract's memory are the isolate's.
   */
  async #ocrInIsolate(image: ArrayBuffer | RawImage, lang: string, options: RecognizeOptions) {
    let modelSource: ModelSource = "memory";
    let modelBytes = 0;
    const r = await ocrInIsolate(
      this.env,
      this.ctx.id.toString(),
      lang,
      image,
      options,
      async () => {
        const base = this.env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL;
        const model = await loadModel(this.#sql, lang, base);
        modelSource = model.source;
        modelBytes = model.bytes.byteLength;
        return model.bytes;
      },
    );
    const { wasmMemoryBytes, decodedBytes, modelSent, isolateId, ...result } = r;
    return {
      ...result,
      lang,
      engine: "isolate" as const,
      isolate: { id: isolateId, modelSent },
      cell: { bootId: bootId(), requests: this.#requests },
      model: { source: modelSource, bytes: modelBytes },
      wasmMemoryMiB: mib(wasmMemoryBytes),
      decodedMiB: mib(decodedBytes),
    };
  }

  async stats() {
    return {
      bootId: bootId(),
      requests: this.#requests,
      enginesLoaded: [...this.#engines.keys()],
      isolateOffered: isolateOffered(this.env),
      models: storedModels(this.#sql),
    };
  }
}
