/**
 * pdf.js inside a Worker: no Web Worker (its "worker" runs in the same isolate through
 * `globalThis.pdfjsWorker`), no canvas (images come as raw pixels), no font loading. Text
 * extraction and image decoding need none of these.
 */
import {
  getDocument,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import jbig2Wasm from "../../node_modules/pdfjs-dist/wasm/jbig2.wasm";
import openjpegWasm from "../../node_modules/pdfjs-dist/wasm/openjpeg.wasm";
import qcmsWasm from "../../node_modules/pdfjs-dist/wasm/qcms_bg.wasm";
import { registerPrecompiledWasm } from "../wasm-shim.ts";

// pdf.js decodes JBIG2 and JPEG 2000 images (and ICC colours) with wasm it fetches and compiles
// at runtime, which workerd forbids; its JS fallbacks are imported from a URL, which a Worker
// cannot do either. The modules come precompiled instead: pdf.js is handed marker bytes for
// each file (BinaryDataFactory) and the shim instantiates the matching module.
const decoders = registerPrecompiledWasm({
  "jbig2.wasm": jbig2Wasm,
  "openjpeg.wasm": openjpegWasm,
  "qcms_bg.wasm": qcmsWasm,
});

/** What pdf.js fetches through the main thread: wasm only (no CMaps or standard fonts here). */
class PrecompiledBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind === "wasmUrl" && decoders.has(filename)) return decoders.markerFor(filename);
    throw new Error(`ENOENT: ${kind} ${filename} is not bundled`);
  }
}

let workerReady: Promise<void> | undefined;

/** Loads pdf.js's worker module into this isolate (once). */
function ensureInThreadWorker(): Promise<void> {
  workerReady ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs").then((worker) => {
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  });
  return workerReady;
}

/** Options for every document: no canvas, no fonts, the precompiled decoders. */
const COMMON_OPTIONS = {
  // Raw pixels instead of ImageBitmaps; JS image decoders instead of the browser's.
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  // No FontFace in Workers (pdf.js 6 no longer evaluates font programs).
  disableFontFace: true,
  useSystemFonts: false,
  // Font names tell bold and italic apart (see the library's fontStyle).
  fontExtraProperties: true,
  // Binary files come from the factory: the precompiled decoders.
  useWorkerFetch: false,
  BinaryDataFactory: PrecompiledBinaryDataFactory,
  useWasm: true,
  verbosity: 0,
};

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  await ensureInThreadWorker();
  return getDocument({ data, ...COMMON_OPTIONS }).promise;
}

/** What a range-loaded document has read so far. */
export type RangeStats = { length: number; bytesRead: number; requests: number };

/** pdf.js asks for byte ranges as it needs them; each is read from `read` (synchronous). */
class ReaderTransport extends PDFDataRangeTransport {
  constructor(
    length: number,
    initialData: Uint8Array,
    private readonly read: (begin: number, end: number) => Uint8Array,
    private readonly stats: RangeStats,
  ) {
    super(length, initialData);
  }

  override requestDataRange(begin: number, end: number): void {
    const chunk = this.read(begin, end);
    this.stats.bytesRead += chunk.byteLength;
    this.stats.requests += 1;
    // Answered on a later turn, as a network transport would.
    queueMicrotask(() => this.onDataRange(begin, chunk));
  }
}

/** Range requests are this many bytes (pdf.js's default); the first one comes with the open. */
const RANGE_CHUNK = 64 * 1024;

/**
 * Opens a PDF of `length` bytes reading only the ranges pdf.js asks for (no auto-fetch of the
 * rest): the trailer, the xref, then each page's objects and streams as pages are read. Note
 * that pdf.js still allocates one zero-filled buffer of `length` bytes to keep what it read
 * (ChunkedStream); what this saves is reading, and copying, the bytes it never needs.
 */
export async function openPdfRanges(
  length: number,
  read: (begin: number, end: number) => Uint8Array,
): Promise<{ pdf: PDFDocumentProxy; stats: RangeStats }> {
  await ensureInThreadWorker();
  const stats: RangeStats = { length, bytesRead: 0, requests: 0 };
  const initial = read(0, Math.min(length, RANGE_CHUNK));
  stats.bytesRead += initial.byteLength;
  const transport = new ReaderTransport(length, initial, read, stats);
  const pdf = await getDocument({
    range: transport,
    rangeChunkSize: RANGE_CHUNK,
    disableAutoFetch: true,
    disableStream: true,
    ...COMMON_OPTIONS,
  }).promise;
  return { pdf, stats };
}
