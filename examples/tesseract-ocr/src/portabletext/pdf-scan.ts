/**
 * pdf.js page scanning without canvas or Vite: page size, text runs (with
 * bold/italic and visibility) and the raster images painted on a page as raw
 * pdf.js image objects with their placement. Works in browsers, Node and
 * Workers runtimes; `pdf-extract.ts` adds the browser parts (worker setup,
 * bitmaps, rendering).
 */
import { OPS, type PDFPageProxy, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageBox } from "./schema.ts";
import type { TextRun } from "./text-layout.ts";

export function pageSize(page: PDFPageProxy): { width: number; height: number } {
  const { width, height } = page.getViewport({ scale: 1 });
  return { width, height };
}

/** Text drawn by a page, split by visibility (letters and digits only, no spaces). */
/** A show-text operation's text (compacted), in content-stream order. */
export type TextSegment = { text: string; invisible: boolean };

export type TextVisibility = {
  visible: string;
  invisible: string;
  /** The operations in order, for classifying runs in order (`createRunClassifier`). */
  segments?: TextSegment[];
};

/** Text rendering modes that paint nothing: 3 (invisible) and 7 (clip only). */
const INVISIBLE_MODES = new Set([3, 7]);
// NFKC on both sides: text content is NFKC-normalised ("ﬁ" → "fi"), glyph unicode is not.
const compact = (s: string) => s.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Collects the text of every show-text operation, split by text rendering
 * mode. OCR tools (OCRmyPDF, scanners, Acrobat) put the recognised text over
 * the scan in mode 3: `getTextContent` does not tell it apart, this does.
 */
export async function scanTextVisibility(page: PDFPageProxy): Promise<TextVisibility> {
  const opList = await page.getOperatorList();
  let mode = 0;
  const stack: number[] = [];
  const visible: string[] = [];
  const invisible: string[] = [];
  const segments: TextSegment[] = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      // Forms and annotation appearances get their own graphics state, as when painted.
      case OPS.save:
      case OPS.paintFormXObjectBegin:
      case OPS.beginAnnotation:
        stack.push(mode);
        break;
      case OPS.restore:
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        mode = stack.pop() ?? mode;
        break;
      case OPS.setTextRenderingMode:
        mode = args[0];
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const glyphs = args[args.length - 1];
        if (!Array.isArray(glyphs)) break;
        let text = "";
        for (const g of glyphs) if (g && typeof g === "object" && g.unicode) text += g.unicode;
        const piece = compact(text);
        const hidden = INVISIBLE_MODES.has(mode);
        (hidden ? invisible : visible).push(piece);
        if (piece) segments.push({ text: piece, invisible: hidden });
        break;
      }
    }
  }
  return { visible: visible.join(""), invisible: invisible.join(""), segments };
}

/** Whether a text run belongs to the invisible part of the page's text (no order known). */
export function isInvisibleRun(str: string, visibility: TextVisibility): boolean {
  if (visibility.invisible === "") return false;
  const s = compact(str);
  if (s === "") return visibility.visible === "";
  return visibility.invisible.includes(s) && !visibility.visible.includes(s);
}

/**
 * Classifies the page's text runs in order. Text content items follow the content stream, as
 * the show-text operations do, so each run is looked up from where the previous one matched:
 * a short visible word ("the") is not taken for the same word in an invisible layer elsewhere,
 * nor the reverse. A run not found in order falls back to `isInvisibleRun`.
 */
export function createRunClassifier(visibility: TextVisibility): (str: string) => boolean {
  if (visibility.invisible === "" || !visibility.segments)
    return (str) => isInvisibleRun(str, visibility);
  const stream = visibility.segments.map((g) => g.text).join("");
  const hidden = new Uint8Array(stream.length);
  let at = 0;
  for (const g of visibility.segments) {
    if (g.invisible) hidden.fill(1, at, at + g.text.length);
    at += g.text.length;
  }
  let cursor = 0;
  return (str) => {
    const s = compact(str);
    if (s === "") return isInvisibleRun(str, visibility);
    const found = stream.indexOf(s, cursor);
    if (found < 0) return isInvisibleRun(str, visibility);
    cursor = found + s.length;
    return hidden[found] === 1;
  };
}

type FontInfo = { name?: string; bold?: boolean; black?: boolean; italic?: boolean };

const BOLD_NAME = /bold|black|heavy|semibold|demi|(^|[+-])(cmbx|cmb|sfbx|sfb|ecbx|ecb|lmbx)/i;
const ITALIC_NAME = /italic|oblique|slanted|(^|[+-])(cmti|cmsl|sfti|sfsl|ecti|ecsl|cmbxti|cmbxsl)/i;

/** Bold / italic of a font, from pdf.js flags and the font name (incl. TeX names like CMBX10). */
export function fontStyle(font: FontInfo | null | undefined): { bold: boolean; italic: boolean } {
  const name = (font?.name ?? "").replace(/^[A-Z]{6}\+/, "");
  return {
    bold: !!(font?.bold || font?.black) || BOLD_NAME.test(name),
    italic: !!font?.italic || ITALIC_NAME.test(name),
  };
}

/** Text-layer runs of a page in top-left point coordinates. */
export async function extractTextRuns(page: PDFPageProxy): Promise<TextRun[]> {
  const viewport = page.getViewport({ scale: 1 });
  // The operator list (scanned for visibility) loads the fonts into commonObjs.
  const [content, visibility] = await Promise.all([
    page.getTextContent(),
    scanTextVisibility(page),
  ]);
  const styles = new Map<string, { bold: boolean; italic: boolean }>();
  const styleOf = (fontName: string) => {
    let style = styles.get(fontName);
    if (!style) {
      const font = page.commonObjs.has(fontName)
        ? (page.commonObjs.get(fontName) as FontInfo)
        : null;
      style = fontStyle(font);
      styles.set(fontName, style);
    }
    return style;
  };
  const invisibleRun = createRunClassifier(visibility);
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const tx = Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    // Item width is in text space; scale it by the horizontal axis length.
    const scaleX =
      Math.hypot(tx[0], tx[1]) / Math.max(Math.hypot(item.transform[0], item.transform[1]), 1e-6);
    runs.push({
      str: item.str,
      x: tx[4],
      y: tx[5],
      width: item.width * scaleX,
      fontSize,
      hasEOL: item.hasEOL,
      ...(invisibleRun(item.str) ? { invisible: true } : {}),
      ...(item.fontName && styleOf(item.fontName).bold ? { bold: true } : {}),
      ...(item.fontName && styleOf(item.fontName).italic ? { italic: true } : {}),
    });
  }
  return runs;
}

type Matrix = [number, number, number, number, number, number];

/** pdf.js image object, either decoded to an ImageBitmap or raw pixels. */
/** Structural stand-in for ImageBitmap, so this module needs no DOM types. */
export type CanvasImageSourceLike = { readonly width: number; readonly height: number };

export type PdfjsImage = {
  width: number;
  height: number;
  /** An ImageBitmap where pdf.js decoded to one (browsers); typed loosely for DOM-less hosts. */
  bitmap?: CanvasImageSourceLike;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
};

export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

function getObject(page: PDFPageProxy, objId: string): Promise<PdfjsImage | null> {
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try {
      // A rejected object (pdf.js could not decode it) is skipped, not waited for forever.
      store.get(
        objId,
        (obj: PdfjsImage) => resolve(obj ?? null),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Drawn upright: only scaled and moved (image y axis points up, page y axis down). */
function isUpright(m: Matrix): boolean {
  const eps = 1e-6;
  return Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && m[0] > 0 && m[3] < 0;
}

function unitSquareBox(m: Matrix): PageBox {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map((p) => {
    Util.applyTransform(p, m);
    return p;
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, unit: "pt" };
}

/** A raster image painted on a page: pdf.js's raw image object and its placement. */
export type ImagePlacement = {
  /** pdf.js object id; the same XObject drawn twice keeps the same id. */
  objId: string;
  /** Raw pixels (`data` + `kind`), or a `bitmap` where pdf.js decoded to one. */
  image: PdfjsImage;
  /** A 1-bit stencil mask: a 0 bit is painted with the fill colour. */
  stencil: boolean;
  bbox: PageBox;
  /** Set when not drawn upright: maps the image's unit square to page points. */
  transform?: number[];
};

/**
 * Raster images painted on a page, with their placement. Walks the operator
 * list tracking the current transformation matrix: an image is painted into
 * the unit square of the CTM, so its page bbox is that square transformed.
 */
export async function scanImagePlacements(
  page: PDFPageProxy,
  options: { minSize?: number } = {},
): Promise<ImagePlacement[]> {
  const minSize = options.minSize ?? 24;
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  const placements: {
    objId: string | null;
    inline?: PdfjsImage;
    ctm: Matrix;
    stencil?: boolean;
  }[] = [];
  let ctm = viewport.transform.slice() as Matrix;
  const stack: Matrix[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args) as Matrix;
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        // pdf.js 6 passes the form's /Matrix as a Float32Array: any 6-number array-like.
        if (args[0] && args[0].length === 6)
          ctm = Util.transform(ctm, Array.from(args[0] as ArrayLike<number>)) as Matrix;
        break;
      case OPS.beginAnnotation:
        // An appearance stream is painted at the annotation: [id, rect, transform, matrix, …].
        stack.push(ctm);
        ctm = Util.transform(
          Util.transform(viewport.transform, Array.from(args[2] as ArrayLike<number>)),
          Array.from(args[3] as ArrayLike<number>),
        ) as Matrix;
        break;
      case OPS.endAnnotation:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
        placements.push({ objId: args[0], ctm });
        break;
      case OPS.paintInlineImageXObject:
        placements.push({ objId: null, inline: args[0], ctm });
        break;
      case OPS.paintImageMaskXObject:
        // Stencil masks (1-bit scans are often stored this way) come as data.
        placements.push({ objId: null, inline: args[0], ctm, stencil: true });
        break;
    }
  }

  const out: ImagePlacement[] = [];
  let inlineCount = 0;
  for (const placement of placements) {
    let img = placement.objId ? await getObject(page, placement.objId) : placement.inline;
    // pdf.js 6 passes a stencil mask's pixels as the id of an object in the page's store.
    if (img && typeof (img.data as unknown) === "string") {
      const stored = await getObject(page, img.data as unknown as string);
      img = stored
        ? { ...stored, width: stored.width ?? img.width, height: stored.height ?? img.height }
        : null;
    }
    if (!img || img.width < minSize || img.height < minSize) continue;
    out.push({
      objId: placement.objId ?? `${placement.stencil ? "mask" : "inline"}-${inlineCount++}`,
      image: img,
      stencil: !!placement.stencil,
      bbox: unitSquareBox(placement.ctm),
      ...(isUpright(placement.ctm)
        ? {}
        : { transform: placement.ctm.map((v) => Math.round(v * 1000) / 1000) }),
    });
  }
  return out;
}
