// pdf.js's worker module, loaded into the same isolate (see pdfjs.ts): only its presence matters.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
