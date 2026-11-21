/**
 * PDF → PortableText inside a Worker. The text layer is laid out by the converter library's
 * canvas-free core (paragraphs, headings, lists, tables, bold/italic, invisible OCR layers,
 * column-aware reading order); every raster image is OCR'd by the OCR cell of the document's
 * language, which answers with words and their boxes in the image's pixels.
 *
 * Pages are converted one at a time and released (page.cleanup) before the next, and each page
 * is handed to `onPage` as soon as it is done, so a caller can stream them.
 */

import { encode as encodePng } from "fast-png";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RawImage } from "../decode.ts";
import type { OcrResult } from "../ocr.ts";
import {
  bodyFontSize,
  createKeyGen,
  DEFAULT_LANGUAGE,
  detectLanguage,
  extractTextRuns,
  IMAGE_KIND,
  type ImageAsset,
  type ImageBlock,
  type ImagePlacement,
  type Language,
  languageByTesseract,
  layoutText,
  letterCount,
  MIN_TEXT_LAYER_LETTERS,
  type OcrWord,
  type OrderBox,
  ocrWordsToBlocks,
  type PageInfo,
  type PdfPortableTextDocument,
  type PortableTextBlock,
  pageSize,
  paragraphToBlock,
  readingOrder,
  roundBox,
  scanImagePlacements,
  tableToBlock,
} from "../portabletext/core.ts";
import { openPdf } from "./pdfjs.ts";

export type PdfConvertOptions = {
  /** Tesseract language, or `auto` (from the text layer, else the fallback). */
  lang: string;
  fallbackLang?: string;
  /** OCR every raster image (default true). */
  ocrImages?: boolean;
  minImageSize?: number;
  minConfidence?: number;
  maxPages?: number;
  /** Recognises a raw image in the language's OCR cell. */
  ocr: (image: RawImage, lang: string) => Promise<OcrResult & { wasmMemoryMiB?: number }>;
  /** Called with each page as soon as it is converted. */
  onPage?: (page: PageResult) => void | Promise<void>;
};

export type PageResult = {
  page: PageInfo;
  blocks: PortableTextBlock[];
  /** Assets first used on this page, with their PNG bytes. */
  assets: { meta: ImageAsset; png: Uint8Array }[];
};

/** Raw images above this many bytes are not sent to OCR cells (RPC message size). */
const MAX_RAW_BYTES = 24 * 1024 * 1024;
const LANGUAGE_SAMPLE_PAGES = 20;
const LANGUAGE_SAMPLE_CHARS = 20_000;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** pdf.js's raw image (or stencil mask) as a RawImage, or null when it has no raw pixels. */
function toRaw(p: ImagePlacement): RawImage | null {
  const { width, height, data, kind } = p.image;
  if (!data) return null;
  if (p.stencil) return { width, height, data, stencil: true };
  if (
    kind === IMAGE_KIND.GRAYSCALE_1BPP ||
    kind === IMAGE_KIND.RGB_24BPP ||
    kind === IMAGE_KIND.RGBA_32BPP
  )
    return { width, height, data, kind };
  return null;
}

/** PNG of a raw image (1-bit images and masks as 8-bit gray). No canvas: fast-png. */
function rawToPng(raw: RawImage): Uint8Array {
  const { width, height, data } = raw;
  if (raw.stencil || raw.kind === 1) {
    const rowBytes = (width + 7) >> 3;
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        gray[y * width + x] = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    return encodePng({ width, height, data: gray, channels: 1, depth: 8 });
  }
  return encodePng({ width, height, data, channels: raw.kind === 2 ? 3 : 4, depth: 8 });
}

/** The options a page needs (no callbacks for whole-document streaming). */
export type PageOptions = Pick<
  PdfConvertOptions,
  "lang" | "ocrImages" | "minImageSize" | "minConfidence" | "ocr"
>;

/** The document's language: the one asked for, or detected from a text sample of the first pages. */
export async function documentLanguage(
  pdf: PDFDocumentProxy,
  options: Pick<PdfConvertOptions, "lang" | "fallbackLang" | "maxPages">,
): Promise<Language> {
  const pageCount = Math.min(pdf.numPages, options.maxPages ?? Number.POSITIVE_INFINITY);
  const fallback = languageByTesseract(options.fallbackLang ?? "") ?? DEFAULT_LANGUAGE;
  // The language: given, or detected from a text-only sample of the first pages.
  let language: Language | undefined;
  if (options.lang === "auto") {
    let sample = "";
    for (let n = 1; n <= Math.min(pageCount, LANGUAGE_SAMPLE_PAGES); n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      for (const item of content.items) if ("str" in item) sample += `${item.str} `;
      if (sample.length >= LANGUAGE_SAMPLE_CHARS) break;
    }
    sample = sample.slice(0, LANGUAGE_SAMPLE_CHARS);
    if (letterCount(sample) >= MIN_TEXT_LAYER_LETTERS) language = detectLanguage(sample);
    language ??= fallback;
  } else {
    language = languageByTesseract(options.lang);
    if (!language) throw new Error(`EINVAL: unsupported language '${options.lang}'`);
  }

  return language;
}

/**
 * Converts page `n`: its text layer, its images (PNG assets, OCR in the language's cell) in
 * reading order. `knownAsset` tells which images earlier pages already stored: those are
 * referenced, not returned again.
 */
export async function convertPage(
  pdf: PDFDocumentProxy,
  n: number,
  language: Language,
  options: PageOptions,
  knownAsset: (id: string) => boolean,
): Promise<PageResult> {
  const page = await pdf.getPage(n);
  try {
    return await convertLoadedPage(page, n, language, options, knownAsset);
  } finally {
    // Also when the page fails: a cached document must not keep its decoded images.
    page.cleanup();
  }
}

async function convertLoadedPage(
  page: PDFPageProxy,
  n: number,
  language: Language,
  options: PageOptions,
  knownAsset: (id: string) => boolean,
): Promise<PageResult> {
  const size = pageSize(page);
  const pageInfo = { number: n, width: round2(size.width), height: round2(size.height) };
  const keyGen = createKeyGen(`p${n}-`);
  const items: { box: OrderBox; blocks: PortableTextBlock[] }[] = [];
  const pageAssets: PageResult["assets"] = [];

  // Text layer: invisible text (an earlier OCR) is dropped, the images are OCR'd here.
  const runs = (await extractTextRuns(page)).filter((r) => !r.invisible);
  const { paragraphs, tables } = layoutText(runs);
  const bodySize = bodyFontSize(paragraphs);
  for (const p of paragraphs) {
    const block = paragraphToBlock(p, { keyGen, page: n, bodySize });
    block.language = (detectLanguage(p.text) ?? language).bcp47;
    items.push({ box: p.bbox, blocks: [block] });
  }
  for (const t of tables)
    items.push({ box: t.bbox, blocks: [tableToBlock(t, { keyGen, page: n })] });

  // Images: raw pixels from pdf.js → asset (PNG) and OCR in the language's cell.
  const jobs: Promise<void>[] = [];
  for (const placement of await scanImagePlacements(page, {
    minSize: options.minImageSize ?? 48,
  })) {
    const raw = toRaw(placement);
    if (!raw) continue;
    const png = rawToPng(raw);
    const sha1hash = await sha1Hex(png);
    const id = `image-${sha1hash}-${raw.width}x${raw.height}-png`;
    if (!knownAsset(id)) {
      const meta: ImageAsset = {
        _id: id,
        _type: "sanity.imageAsset",
        mimeType: "image/png",
        extension: "png",
        size: png.byteLength,
        sha1hash,
        path: `assets/${id}.png`,
        metadata: {
          dimensions: {
            width: raw.width,
            height: raw.height,
            aspectRatio: Math.round((raw.width / raw.height) * 10000) / 10000,
          },
        },
      };
      pageAssets.push({ meta, png });
    }
    const asset = { _type: "reference" as const, _ref: id };
    const imageBlock: ImageBlock = {
      _type: "image",
      _key: keyGen("img"),
      asset,
      width: raw.width,
      height: raw.height,
      mimeType: "image/png",
      source: {
        type: "pdfImage",
        page: n,
        bbox: roundBox(placement.bbox),
        ...(placement.transform ? { transform: placement.transform } : {}),
        ...(placement.stencil ? { stencil: true } : {}),
      },
    };
    const item = {
      box: placement.bbox as OrderBox,
      blocks: [imageBlock] as PortableTextBlock[],
    };
    items.push(item);
    if (options.ocrImages === false || raw.data.byteLength > MAX_RAW_BYTES) continue;
    const lang = language;
    jobs.push(
      options.ocr(raw, lang.tesseract).then((r) => {
        const words: OcrWord[] = r.words.map((w) => ({
          text: w.text,
          confidence: w.confidence,
          rect: {
            left: w.bbox.x,
            top: w.bbox.y,
            right: w.bbox.x + w.bbox.width,
            bottom: w.bbox.y + w.bbox.height,
          },
          startOfLine: w.startOfLine,
          endOfLine: w.endOfLine,
        }));
        const textBlocks = ocrWordsToBlocks(words, {
          keyGen,
          page: n,
          imageKey: imageBlock._key,
          asset,
          minConfidence: options.minConfidence ?? 0.3,
          language: lang.bcp47,
          imageWidth: raw.width,
          imageHeight: raw.height,
        });
        imageBlock.ocr = {
          engine: "tesseract-wasm (durable object)",
          language: lang.bcp47,
          model: lang.tesseract,
          languageSource: options.lang === "auto" ? "document" : "user",
          attempts: [
            { model: lang.tesseract, confidence: r.meanConfidence, words: r.words.length },
          ],
          rotation: 0,
          blocks: textBlocks.map((b) => b._key),
          wordCount: textBlocks.reduce((s, b) => s + b.children.length, 0),
          confidence: round3(r.meanConfidence),
          durationMs: 0,
        };
        item.blocks.push(...textBlocks);
      }),
    );
  }
  await Promise.all(jobs);

  const pageBlocks = readingOrder(items.map((i) => i.box)).flatMap((i) => items[i].blocks);
  return { page: pageInfo, blocks: pageBlocks, assets: pageAssets };
}

export async function convertPdfInWorker(
  bytes: Uint8Array,
  name: string,
  options: PdfConvertOptions,
): Promise<PdfPortableTextDocument> {
  const pdf = await openPdf(bytes);
  const pageCount = Math.min(pdf.numPages, options.maxPages ?? Number.POSITIVE_INFINITY);
  const pages: PageInfo[] = [];
  const blocks: PortableTextBlock[] = [];
  const assets: Record<string, ImageAsset> = {};
  try {
    const language = await documentLanguage(pdf, options);
    for (let n = 1; n <= pageCount; n++) {
      const result = await convertPage(pdf, n, language, options, (id) => id in assets);
      for (const a of result.assets) assets[a.meta._id] = a.meta;
      pages.push(result.page);
      blocks.push(...result.blocks);
      await options.onPage?.(result);
    }
    return assembleDocument(name, bytes.byteLength, language, pages, blocks, assets);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export function assembleDocument(
  name: string,
  size: number,
  language: Language,
  pages: PageInfo[],
  blocks: PortableTextBlock[],
  assets: Record<string, ImageAsset>,
): PdfPortableTextDocument {
  return {
    _type: "pdfDocument",
    version: 1,
    title: name.replace(/\.pdf$/i, ""),
    language: language.bcp47,
    source: { fileName: name, size, pageCount: pages.length },
    createdAt: new Date().toISOString(),
    pages,
    blocks,
    assets,
  };
}
