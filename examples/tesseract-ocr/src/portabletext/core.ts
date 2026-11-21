/**
 * The parts of the converter that need neither a DOM, canvas, Web Workers nor
 * Vite: pdf.js page scanning (text runs, visibility, image placements as raw
 * pixels), text layout (paragraphs, headings, lists, tables, styles), reading
 * order and OCR words → PortableText blocks. For servers and Workers runtimes
 * that bring their own pdf.js setup and OCR (as this example does).
 */
export { createKeyGen, type KeyGen } from "./keys.ts";
export {
  DEFAULT_LANGUAGE,
  detectLanguage,
  LANGUAGES,
  type Language,
  languageByBcp47,
  languageByTesseract,
  letterCount,
  MIN_TEXT_LAYER_LETTERS,
} from "./languages.ts";
export { type OcrWord, ocrWordsToBlocks, uprightToImage } from "./ocr-layout.ts";
export {
  createRunClassifier,
  extractTextRuns,
  fontStyle,
  IMAGE_KIND,
  type ImagePlacement,
  isInvisibleRun,
  type PdfjsImage,
  pageSize,
  scanImagePlacements,
  scanTextVisibility,
  type TextVisibility,
} from "./pdf-scan.ts";
export { type OrderBox, readingOrder } from "./reading-order.ts";
export type * from "./schema.ts";
export { runsToImageWords } from "./text-layer-ocr.ts";
export {
  bodyFontSize,
  layoutText,
  type Paragraph,
  paragraphToBlock,
  roundBox,
  type Table,
  type TextRun,
  tableToBlock,
} from "./text-layout.ts";
