import type { OcrWord } from "./ocr-layout.ts";
import type { PageBox } from "./schema.ts";
import type { TextRun } from "./text-layout.ts";

/**
 * Turns the invisible text layer an OCR tool left over a scan into OCR words
 * of that scan: each word's page position is mapped into the image's pixels.
 * Only for images drawn upright (no rotation or skew).
 *
 * Runs are split into words by whitespace; a word's horizontal extent is
 * taken in proportion to its character offsets within the run (OCR layers
 * usually stretch each word to its scanned width, so this is close).
 */
export function runsToImageWords(
  runs: TextRun[],
  image: { bbox: PageBox; width: number; height: number },
): OcrWord[] {
  const { bbox, width, height } = image;
  const sx = width / bbox.width;
  const sy = height / bbox.height;
  const inside = runs.filter((r) => {
    const cx = r.x + r.width / 2;
    const cy = r.y - r.fontSize / 3;
    return cx >= bbox.x && cx <= bbox.x + bbox.width && cy >= bbox.y && cy <= bbox.y + bbox.height;
  });
  const clampX = (v: number) => Math.max(0, Math.min(width, Math.round(v)));
  const clampY = (v: number) => Math.max(0, Math.min(height, Math.round(v)));

  const words: OcrWord[] = [];
  let lastBaseline: number | null = null;
  for (const run of inside) {
    const chars = run.str.length || 1;
    const charWidth = run.width / chars;
    const newLine = lastBaseline === null || Math.abs(run.y - lastBaseline) > run.fontSize * 0.5;
    if (newLine && words.length > 0) words[words.length - 1].endOfLine = true;
    lastBaseline = run.y;
    let first = true;
    for (const match of run.str.matchAll(/\S+/g)) {
      const start = match.index ?? 0;
      const x0 = run.x + start * charWidth;
      const x1 = x0 + match[0].length * charWidth;
      words.push({
        text: match[0],
        // The tool that wrote the layer did not record confidences.
        confidence: 1,
        rect: {
          left: clampX((x0 - bbox.x) * sx),
          right: clampX((x1 - bbox.x) * sx),
          top: clampY((run.y - run.fontSize * 0.8 - bbox.y) * sy),
          bottom: clampY((run.y + run.fontSize * 0.2 - bbox.y) * sy),
        },
        startOfLine: newLine && first,
        endOfLine: false,
      });
      first = false;
    }
  }
  if (words.length > 0) words[words.length - 1].endOfLine = true;
  return words;
}
