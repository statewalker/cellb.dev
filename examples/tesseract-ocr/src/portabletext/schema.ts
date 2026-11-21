/**
 * PortableText document model produced by the converter.
 *
 * The top-level `blocks` array is plain PortableText: standard `block` objects
 * plus one custom `image` type. Everything extra (geometry, OCR provenance) is
 * carried in additional fields and mark definitions, which PortableText
 * renderers ignore unless told otherwise.
 *
 * Coordinate conventions:
 * - `PageBox` is in PDF user-space points (1/72 in), origin at the top-left of
 *   the page, y growing downwards (the same frame as pdf.js viewports at scale 1).
 * - `PixelBox` is in pixels of the referenced binary image, origin top-left.
 */

export type Box = { x: number; y: number; width: number; height: number };
export type PageBox = Box & { unit: "pt" };
export type PixelBox = Box & { unit: "px" };

/** Reference to an asset in `PdfPortableTextDocument.assets`, Sanity-style. */
export type AssetReference = { _type: "reference"; _ref: string };

export type Span = {
  _type: "span";
  _key: string;
  text: string;
  marks: string[];
};

/**
 * Mark definition attached to every OCR-recognised word: points at the image
 * block the text came from and at the word's bounding box inside that image.
 */
export type OcrBoxMark = {
  _type: "ocrBox";
  _key: string;
  /** `_key` of the `image` block the word was recognised in. */
  image: string;
  /** Asset holding the binary image the bbox refers to. */
  asset: AssetReference;
  bbox: PixelBox;
  /** Recognition confidence in [0, 1]. */
  confidence: number;
};

/** Where the text of a block came from. */
export type BlockSource =
  | { type: "pdfText"; page: number; bbox: PageBox }
  | {
      type: "ocr";
      page: number;
      /** `_key` of the `image` block the paragraph was recognised in. */
      image: string;
      asset: AssetReference;
      /** Paragraph bounding box in image pixels. */
      bbox: PixelBox;
      confidence: number;
    };

export type TextBlock = {
  _type: "block";
  _key: string;
  style: "normal" | "h1" | "h2" | "h3";
  /** BCP 47 language of the block's text, when known. */
  language?: string;
  /** Standard PortableText list fields. */
  listItem?: "bullet" | "number";
  level?: number;
  /** Marks on spans are `ocrBox` keys or the decorators `strong` / `em`. */
  markDefs: OcrBoxMark[];
  children: Span[];
  source: BlockSource;
};

export type ImageBlock = {
  _type: "image";
  _key: string;
  asset: AssetReference;
  /** Intrinsic size of the binary image in pixels. */
  width: number;
  height: number;
  mimeType: string;
  source: {
    type: "pdfImage" | "pageRender";
    page: number;
    /** Axis-aligned bounds of the image on the page; may extend past the page edges. */
    bbox: PageBox;
    /**
     * A 1-bit stencil mask (painted pixels black, the rest transparent).
     */
    stencil?: boolean;
    /**
     * Only for images not drawn upright (rotated, flipped, skewed): matrix mapping the image's unit
     * square to page points; (0,1) is the image's top-left corner.
     */
    transform?: number[];
  };
  ocr?: {
    engine: string;
    /** BCP 47 language of the recognised text. */
    language: string;
    /** Tesseract model the kept result was recognised with. */
    model: string;
    /** How the model was chosen. */
    languageSource: "user" | "detected" | "document" | "default";
    /** Models tried, in order, with the mean word confidence each produced. */
    attempts: { model: string; confidence: number; words: number }[];
    /** Clockwise rotation of the text in the image, corrected before recognition. */
    rotation: number;
    /** `_key`s of the text blocks recognised in this image, in reading order. */
    blocks: string[];
    wordCount: number;
    confidence: number;
    durationMs: number;
  };
};

/** Table in the shape of `@sanity/table`: rows of plain-text cells. */
export type TableBlock = {
  _type: "table";
  _key: string;
  rows: { _type: "tableRow"; _key: string; cells: string[] }[];
  /** Leading rows set entirely in bold (column headers). */
  headerRows?: number;
  source: { type: "pdfText"; page: number; bbox: PageBox };
};

export type PortableTextBlock = TextBlock | ImageBlock | TableBlock;

/** Asset metadata, shaped like a Sanity `sanity.imageAsset` document. */
export type ImageAsset = {
  _id: string;
  _type: "sanity.imageAsset";
  mimeType: string;
  extension: string;
  size: number;
  sha1hash: string;
  /** Path of the binary inside the exported ZIP bundle. */
  path: string;
  metadata: { dimensions: { width: number; height: number; aspectRatio: number } };
};

export type PageInfo = { number: number; width: number; height: number };

export type PdfPortableTextDocument = {
  _type: "pdfDocument";
  version: 1;
  title: string;
  /** Dominant BCP 47 language of the document text. */
  language?: string;
  source: { fileName: string; size: number; pageCount: number };
  createdAt: string;
  pages: PageInfo[];
  blocks: PortableTextBlock[];
  assets: Record<string, ImageAsset>;
};
