# Tesseract OCR on CellB

`@statewalker/tesseract-ocr-example`: OCR and PDF → PortableText in Durable Objects, one Worker
project that runs unchanged on CellB in Node and in a browser tab. The package is private, since
it is a test of CellB and not a library. It comes from statewalker-sandbox (`apps/tesseract-do`,
which also runs on wrangler and celld), with the canvas-free core of its PDF converter
(`packages/pdf-portabletext`) vendored in `src/portabletext/`.

## Why it exists

It is a real Worker that CellB did not write and that leans on the parts of the platform other
examples do not:

- **WebAssembly as modules.** Tesseract (`tesseract-wasm`) and pdf.js's JBIG2, JPEG 2000 and
  colour decoders are `.wasm` imports. The code instantiates them through a shim
  (`src/wasm-shim.ts`), as workerd forbids compiling wasm at runtime.
- **CPU-bound objects with large memory.** An `OcrCell` per language holds a Tesseract engine
  (30–70 MiB of wasm memory) and reads large pages in bands.
- **SQLite as a blob store.** Models are cached in the cell's SQLite in 1 MiB chunks; a `PdfJob`
  object keeps an uploaded PDF (up to 64 MB), its pages and PNG assets there, and pdf.js reads the
  PDF by byte ranges from it.
- **Alarms as a job queue.** A `PdfJob` converts a batch of pages per alarm, with per-page
  transactions, retries and resume after a restart.
- **Worker Loader.** With `engine=isolate`, recognition runs in a Worker Loader isolate per
  language (`src/isolate-client.ts`).

## How to use it

```
pnpm install            # in examples/ (their own workspace; CellB from npm); needs network
pnpm fixtures           # in this directory: test images, PDFs and models into fixtures/
pnpm test               # vitest in Node: test/ocr-on-cellb.test.ts
pnpm test:browser       # cellb build into browser/public/app, then Playwright in Chromium
```

The routes (`src/worker.ts`): `POST /api/ocr?lang=eng[&engine=isolate]` (a PNG or JPEG),
`POST /api/pdf?lang=auto|eng[&stream=1]` (a PDF, converted in the request), and
`POST /api/pdf/jobs` with `GET /api/pdf/jobs/:id[/document|/pages/:n|/assets/:id]` (a PDF
converted by a `PdfJob`). The app fetches models from `MODEL_BASE_URL` and, for isolates,
`tesseract-core.wasm` from `WASM_URL` (vars in `wrangler.jsonc`; without them, the models come from
GitHub's tessdata_fast).

## Examples

What `test/ocr-on-cellb.test.ts` proves on Node (`loadProject` from `@statewalker/cellb/node`,
cells' SQLite in a temporary directory):

1. The project loads with nothing in `unsupported`.
2. A JPEG book page is read in the `ocr-eng` cell; a 2550×3300 two-column scan is read in bands and
   matches its transcript (99%); a Dutch page goes to the `ocr-nld` cell with the Dutch model; the
   same OCR runs in a Worker Loader isolate.
3. Bad input is refused: not an image (400), a PNG declaring 60000×60000 (413, before decoding),
   one-row bands (400).
4. PDFs: a two-column LaTeX paper with its table; a JBIG2 scan decoded and OCR'd, the word boxes
   inside the image; a JPEG 2000 picture; German detected from the text layer, bold kept; a PDF
   streamed as NDJSON, one event per page.
5. Jobs: 117 pages in 30 alarms of 4 pages; four scanned pages at once over three cells, the PNG
   served by the job; a 34 MB upload streamed in, of which pdf.js reads under a tenth.
6. After a restart on the same data: the Dutch model comes from the cell's SQLite (no download),
   and a throttled job left half-way resumes and finishes all its pages in order.

What `test/browser/ocr-in-browser.spec.ts` proves in Chromium: `cellb build` writes the project to
`browser/public/app`, a Dedicated Worker (`browser/app-worker.ts`) loads it with `loadProject` from
`@statewalker/cellb/browser` (SQLite WASM on OPFS, Worker Loader isolates in workers of their own),
and the page drives it (`browser/main.ts`):

1. OCR in a cell, the model downloaded once; the banded scan matches its transcript; OCR in a
   Worker Loader isolate.
2. The JBIG2 scan, the JPEG 2000 picture, the table and the German text, as on Node.
3. The four-page scan job, its PNG served from the job.
4. The app closes with a throttled job half-way; the page reloads and loads it again on the same
   OPFS pool: the model comes from SQLite (no new download), and the job resumes and finishes.
5. Nothing is reported as a page error on the way.

## Internals

### What the move from wrangler to CellB changed

The Worker's code is the same as on wrangler and celld, except for one shim (below). What
differs is around it:

- **Vars.** CellB takes `vars` from the configuration only. The Node suite loads the project
  through a generated `wrangler.json` with `MODEL_BASE_URL` and `WASM_URL` pointing at its model
  server (`test/app.ts`); the Vite server of the browser suite serves the built
  `/app/wrangler.json` with the vars pointing at itself.
- **`define`.** Tesseract's Emscripten glue computes `new URL("tesseract-core.wasm",
  import.meta.url)` (never fetched: the wasm comes as a module). On workerd the bundle has no
  usable `import.meta.url`, which wrangler's `define` in `wrangler.jsonc` fixes; CellB does not
  apply `define` (neither `cellb build` nor `loadProject`). On Node that does not matter (the
  bundle has a `file:` URL), but in a browser CellB runs the bundle from a `blob:` URL, and a
  relative URL cannot resolve against it. `withPrecompiledWasm` therefore lets `URL` fall back to a
  placeholder `file:` base while an engine is created. The `define` stays for wrangler.
- **One event loop on Node.** CellB runs the cells on the process's event loop, and recognition
  holds it for seconds. A server in the same process (the test's model server) then needs a
  keep-alive longer than Node's 5 s default, or a model download that reuses an idle socket right
  after an OCR call fails with "fetch failed".

### Decisions a reader would otherwise undo

- **`cellb build` and `loadProject(url)` in the browser**, rather than `bundleWorkerForBrowser`
  and `browserProjectRuntime`: the documented way to ship a project to browsers, a static folder
  any host can serve.
- **Vite pre-bundles CellB's CommonJS dependencies but not CellB.** CellB is excluded from
  `optimizeDeps` (its isolate worker is located next to its module), so `buffer`, `events`,
  `util`, `assert` and `path-browserify`, which it imports, are listed under `include`; without
  them the worker fails to load ("does not provide an export named 'Buffer'").
- **The PDF converter's core is vendored**, since the examples take their packages from npm and
  `@statewalker/pdf-portabletext` is not published.
- **pdf.js warns about `@napi-rs/canvas` on Node.** Its legacy build sees Node's `process` and
  tries to load a canvas for page rendering; the Worker never renders pages.

## Fixtures

`pnpm fixtures` downloads the test images and PDFs (OCRmyPDF's test resources and py-pdf's sample
files; licenses in `fixtures/LICENSES.txt`) and the tessdata_fast models for English, Dutch,
French and German, and builds `scan-4.pdf` and `big-34mb.pdf` from them with pdf-lib.
