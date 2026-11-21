import type { KeyGen } from "./keys.ts";
import type { AssetReference, OcrBoxMark, PixelBox, Span, TextBlock } from "./schema.ts";

/**
 * Word as reported by the OCR worker, in pixels of the source image. When the
 * worker turned the image upright, rects are in that upright frame; see
 * `uprightToImage`.
 */
export type OcrWord = {
  text: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  rect: { left: number; top: number; right: number; bottom: number };
  startOfLine: boolean;
  endOfLine: boolean;
};

type Line = { words: OcrWord[]; top: number; bottom: number; left: number; right: number };

export type OcrBlocksOptions = {
  keyGen: KeyGen;
  page: number;
  imageKey: string;
  asset: AssetReference;
  /** Words below this confidence are dropped. */
  minConfidence?: number;
  /** BCP 47 language of the recognised text. */
  language?: string;
  /**
   * Clockwise rotation of the content in the source image (0/90/180/270) and
   * the source image size: used to map upright-frame rects back to the image.
   */
  rotation?: number;
  imageWidth?: number;
  imageHeight?: number;
};

type Rect = OcrWord["rect"];

/**
 * Maps a rect from the upright frame back to the source image whose content
 * is rotated clockwise by `rotation` degrees. `width`/`height` are the source
 * image dimensions.
 */
export function uprightToImage(r: Rect, rotation: number, width: number, height: number): Rect {
  switch (rotation) {
    case 90:
      // Content turned 90° clockwise: upright x runs down the image, upright y runs leftwards.
      return { left: width - r.bottom, top: r.left, right: width - r.top, bottom: r.right };
    case 180:
      return {
        left: width - r.right,
        top: height - r.bottom,
        right: width - r.left,
        bottom: height - r.top,
      };
    case 270:
      return { left: r.top, top: height - r.right, right: r.bottom, bottom: height - r.left };
    default:
      return r;
  }
}

/** Groups OCR words into lines, then lines into paragraphs. */
export function groupOcrWords(words: OcrWord[]): OcrWord[][][] {
  const lines = splitLines(words);
  if (lines.length === 0) return [];
  const heights = lines.map((l) => l.bottom - l.top).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;

  const paragraphs: Line[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const gap = line.top - prev.bottom;
    const overlapsHorizontally = line.left < prev.right && line.right > prev.left;
    const breaks =
      gap > medianHeight * 0.8 ||
      gap < -medianHeight || // jumped back up: new column / region
      !overlapsHorizontally;
    if (breaks) paragraphs.push([line]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  return paragraphs.map((p) => p.map((l) => l.words));
}

function splitLines(words: OcrWord[]): Line[] {
  const lines: Line[] = [];
  let current: OcrWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      words: current,
      top: Math.min(...current.map((w) => w.rect.top)),
      bottom: Math.max(...current.map((w) => w.rect.bottom)),
      left: Math.min(...current.map((w) => w.rect.left)),
      right: Math.max(...current.map((w) => w.rect.right)),
    });
    current = [];
  };
  for (const word of words) {
    if (word.startOfLine) flush();
    current.push(word);
    if (word.endOfLine) flush();
  }
  flush();
  return lines;
}

function toBox(words: OcrWord[], map: (r: Rect) => Rect): PixelBox {
  const rects = words.map((w) => map(w.rect));
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { x: left, y: top, width: right - left, height: bottom - top, unit: "px" };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Converts OCR words of one image into PortableText blocks: one block per
 * paragraph, one span per word, and an `ocrBox` mark per span pointing at the
 * word's bbox in the image.
 */
export function ocrWordsToBlocks(words: OcrWord[], options: OcrBlocksOptions): TextBlock[] {
  const { keyGen, page, imageKey, asset, minConfidence = 0, language } = options;
  const { rotation = 0, imageWidth = 0, imageHeight = 0 } = options;
  const map = (r: Rect) => uprightToImage(r, rotation, imageWidth, imageHeight);
  const kept = words.filter((w) => w.text.trim() !== "" && w.confidence >= minConfidence);
  const blocks: TextBlock[] = [];
  for (const paragraph of groupOcrWords(kept)) {
    const markDefs: OcrBoxMark[] = [];
    const children: Span[] = [];
    paragraph.forEach((line, lineIdx) => {
      line.forEach((word, wordIdx) => {
        const isLastWord = lineIdx === paragraph.length - 1 && wordIdx === line.length - 1;
        const markKey = keyGen("w");
        markDefs.push({
          _type: "ocrBox",
          _key: markKey,
          image: imageKey,
          asset,
          bbox: toBox([word], map),
          confidence: round(word.confidence),
        });
        const text = word.text.trim();
        // Words are separated by a trailing space; a hyphen at the end of a line
        // is kept and joins the next line without a space.
        const hyphenated = wordIdx === line.length - 1 && /[-­]$/.test(text);
        const separator = isLastWord || hyphenated ? "" : " ";
        children.push({
          _type: "span",
          _key: keyGen("s"),
          text: text + separator,
          marks: [markKey],
        });
      });
    });
    const allWords = paragraph.flat();
    const confidence = allWords.reduce((s, w) => s + w.confidence, 0) / allWords.length;
    blocks.push({
      _type: "block",
      _key: keyGen("b"),
      style: "normal",
      ...(language ? { language } : {}),
      markDefs,
      children,
      source: {
        type: "ocr",
        page,
        image: imageKey,
        asset,
        bbox: toBox(allWords, map),
        confidence: round(confidence),
      },
    });
  }
  return blocks;
}
