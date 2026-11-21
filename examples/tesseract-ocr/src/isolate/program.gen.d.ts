declare const program: {
  /** The OCR isolate's module (src/isolate/program.ts, bundled): imports ./tesseract-core.wasm. */
  code: string;
  /** SHA-256 (hex) of the tesseract-core.wasm it was built for: the fetched file must match it. */
  wasmSha256: string;
  /** tesseract-wasm's version. */
  tesseractVersion: string;
};
export default program;
