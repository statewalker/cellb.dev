/**
 * HTTP surface of the OCR prototype.
 *
 *   POST /api/ocr?lang=eng[&cell=name][&band=rows][&engine=cell|isolate]
 *        body: a PNG or JPEG image → OCR result (JSON)
 *   POST /api/pdf?lang=auto|eng[&engine=cell|isolate][&maxPages=n][&stream=1][&assets=inline]
 *        body: a PDF → PortableText document (JSON), or page events (NDJSON) with stream=1
 *   POST /api/pdf/jobs?lang=…[&engine=…][&maxPages=n][&pageConcurrency=n][&ocrCells=n]
 *                      [&throttleMs=ms][&name=…]
 *        body: a PDF (≤ 64 MB) → 202 { id, … }: a PdfJob Durable Object converts it, a batch
 *        of pages per alarm
 *   GET  /api/pdf/jobs/:id               the job's status and progress
 *   GET  /api/pdf/jobs/:id/document[?assets=inline]   the pages done so far as one document
 *   GET  /api/pdf/jobs/:id/pages/:n      one converted page (blocks, asset ids)
 *   GET  /api/pdf/jobs/:id/assets/:asset an image asset (PNG)
 *   POST /api/pdf/jobs/:id/cancel        stops the job (keeps what is done)
 *   DELETE /api/pdf/jobs/:id             stops the job and removes everything it stored
 *   GET  /api/cells/:name                the cell's engines and stored models
 *   GET  /api/runtime                    what this runtime allows (wasm compilation, loader, …)
 *
 * Without `cell`, the image goes to the cell of its language (`ocr-<lang>`). `band` sets the
 * rows read at a time (0: the whole image at once; default: about 3 megapixels per band).
 * `engine=isolate` runs recognition in a Worker Loader isolate instead of the cell's own (needs
 * WASM_URL).
 */

import { BLOB_CHUNK } from "./blob-store.ts";
import type { RawImage } from "./decode.ts";
import { type CellOcrResult, type Env, OcrCell } from "./ocr-cell.ts";
import { assembleDocument, convertPdfInWorker, type PageResult } from "./pdf/convert.ts";
import { MAX_JOB_PDF_BYTES, PdfJob } from "./pdf/pdf-job.ts";
import { DEFAULT_LANGUAGE, languageByTesseract } from "./portabletext/core.ts";

export { OcrCell, PdfJob };

/** Request bodies above this are refused (Workers accept 100 MB; images this large do not fit in memory). */
const MAX_BODY = 20 * 1024 * 1024;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorStatus = (message: string) =>
  /^(Error: )?E2BIG/.test(message)
    ? 413
    : /^(Error: )?EINVAL/.test(message)
      ? 400
      : /^(Error: )?EEXIST/.test(message)
        ? 409
        : /^(Error: )?EIO/.test(message)
          ? 502
          : 500;

/**
 * Whether this runtime compiles WebAssembly from bytes: workerd refuses, Node (cellb) allows,
 * and on celld 0.6 the promise never settles, hence the timeout.
 */
async function canCompileWasmBytes(): Promise<boolean | "hangs"> {
  // Not in the Workers types on purpose: workerd disallows it.
  const wasm = WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<unknown> };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      wasm.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => true as const),
      new Promise<"hangs">((resolve) => {
        timer = setTimeout(() => resolve("hangs"), 1000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/runtime") {
        return json({
          userAgent:
            (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? null,
          compileWasmFromBytes: await canCompileWasmBytes(),
          workerLoader: !!env.LOADER,
          isolateEngine: !!env.LOADER && !!env.WASM_URL,
          imageApis: Object.fromEntries(
            ["OffscreenCanvas", "ImageData", "createImageBitmap"].map((name) => [
              name,
              typeof (globalThis as Record<string, unknown>)[name],
            ]),
          ),
          sharedArrayBuffer: typeof SharedArrayBuffer,
        });
      }

      const cellMatch = url.pathname.match(/^\/api\/cells\/([\w.-]+)$/);
      if (cellMatch && request.method === "GET") {
        const stub = env.OCR.get(env.OCR.idFromName(cellMatch[1]));
        return json(await stub.stats());
      }

      if (url.pathname === "/api/ocr" && request.method === "POST") {
        const lang = url.searchParams.get("lang") ?? "eng";
        const cell = url.searchParams.get("cell") ?? `ocr-${lang}`;
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_BODY) return json({ error: "E2BIG: image too large" }, 413);
        const image = await request.arrayBuffer();
        if (image.byteLength === 0 || image.byteLength > MAX_BODY)
          return json({ error: "EINVAL: send a PNG or JPEG image (at most 20 MB)" }, 400);
        const stub = env.OCR.get(env.OCR.idFromName(cell));
        const band = url.searchParams.get("band");
        const engine = url.searchParams.get("engine") === "isolate" ? "isolate" : "cell";
        const options = {
          engine: engine as "cell" | "isolate",
          ...(band === null ? {} : { bandHeight: Number(band) }),
        };
        const result: CellOcrResult = await stub.ocr(image, lang, options);
        return json({ ...result, cellName: cell });
      }

      if (url.pathname === "/api/pdf" && request.method === "POST") {
        return await convertPdfRequest(request, url, env);
      }

      if (url.pathname.startsWith("/api/pdf/jobs")) {
        return await jobRequest(request, url, env);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      return json({ error: message }, errorStatus(message));
    }
  },
};

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * PDF → PortableText. Pages are converted in this request (pdf.js in-thread, no canvas); each
 * image is OCR'd by the cell of the document's language. With `stream=1` every page is sent as
 * soon as it is done (NDJSON: `page` events, then `end` with the document's metadata).
 */
async function convertPdfRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const bytes = await readPdf(request);
  if (bytes instanceof Response) return bytes;
  const lang = url.searchParams.get("lang") ?? "auto";
  const engine = url.searchParams.get("engine") === "isolate" ? "isolate" : "cell";
  const inline = url.searchParams.get("assets") === "inline";
  const maxPages = Number(url.searchParams.get("maxPages")) || undefined;
  if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages > 0))
    return json({ error: "EINVAL: maxPages is a positive integer" }, 400);
  const name = url.searchParams.get("name") ?? "document.pdf";
  const ocr = (image: RawImage, language: string) =>
    env.OCR.get(env.OCR.idFromName(`ocr-${language}`)).ocr(image, language, { engine });
  const pageEvent = (p: PageResult) => ({
    type: "page",
    page: p.page,
    blocks: p.blocks,
    assets: p.assets.map((a) => ({ meta: a.meta, ...(inline ? { png: base64(a.png) } : {}) })),
  });

  if (url.searchParams.get("stream") === "1") {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event: unknown) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    const done = (async () => {
      try {
        const doc = await convertPdfInWorker(bytes, name, {
          lang,
          maxPages,
          ocr,
          onPage: (p) => send(pageEvent(p)),
        });
        const { blocks: _blocks, assets: _assets, ...meta } = doc;
        await send({ type: "end", document: meta });
      } catch (e) {
        await send({ type: "error", error: String((e as Error)?.message ?? e) });
      } finally {
        await writer.close();
      }
    })();
    void done;
    return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
  }

  const pngs: Record<string, string> = {};
  const document = await convertPdfInWorker(bytes, name, {
    lang,
    maxPages,
    ocr,
    onPage: (p) => {
      if (inline) for (const a of p.assets) pngs[a.meta._id] = base64(a.png);
    },
  });
  return json(inline ? { document, assets: pngs } : { document });
}

/** Reads a PDF request body: at most MAX_BODY bytes, starting with `%PDF-`. */
async function readPdf(request: Request): Promise<Uint8Array | Response> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return json({ error: "E2BIG: PDF too large" }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY)
    return json({ error: "EINVAL: send a PDF (at most 20 MB)" }, 400);
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-")
    return json({ error: "EINVAL: not a PDF" }, 400);
  return bytes;
}

/**
 * PDF conversion jobs. Each job is a PdfJob Durable Object of its own (a unique id), which keeps
 * the PDF and the results in its SQLite and converts one page per alarm: the request that
 * creates it returns at once, and the job is not bound by any request's CPU time.
 */
async function jobRequest(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/pdf/jobs" && request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_JOB_PDF_BYTES)
      return json(
        { error: `E2BIG: a job takes PDFs of at most ${MAX_JOB_PDF_BYTES >> 20} MB` },
        413,
      );
    if (!request.body) return json({ error: "EINVAL: send a PDF" }, 400);
    const id = env.PDF_JOB.newUniqueId();
    const job = env.PDF_JOB.get(id);
    // The body goes to the job in 1 MiB parts as it arrives: no side holds the whole upload.
    for await (const part of inParts(request.body, BLOB_CHUNK)) await job.append(part);
    const num = (name: string) => Number(url.searchParams.get(name)) || undefined;
    const view = await job.start(url.searchParams.get("name") ?? "document.pdf", {
      lang: url.searchParams.get("lang") ?? "auto",
      engine: url.searchParams.get("engine") === "isolate" ? "isolate" : "cell",
      maxPages: num("maxPages"),
      throttleMs: Math.max(0, num("throttleMs") ?? 0),
      pageConcurrency: num("pageConcurrency"),
      ocrCells: num("ocrCells"),
    });
    return json({ id: id.toString(), ...view }, 202);
  }

  const m = url.pathname.match(/^\/api\/pdf\/jobs\/([0-9a-f]{64})(?:\/(.*))?$/);
  if (!m) return json({ error: "not found" }, 404);
  const [, id, rest = ""] = m;
  const notFound = () => json({ error: "ENOENT: no such job" }, 404);
  let jobId: DurableObjectId;
  try {
    // An id this namespace did not make is refused here (ids carry a checksum).
    jobId = env.PDF_JOB.idFromString(id);
  } catch {
    return notFound();
  }
  const job = env.PDF_JOB.get(jobId);

  if (rest === "" && request.method === "GET") {
    const view = await job.status();
    return view ? json({ id, ...view }) : notFound();
  }
  if (rest === "" && request.method === "DELETE") {
    const view = await job.status();
    if (!view) return notFound();
    await job.destroy();
    return json({ id, deleted: true });
  }
  if (rest === "cancel" && request.method === "POST") {
    const view = await job.cancel();
    return view ? json({ id, ...view }) : notFound();
  }
  if (rest === "document" && request.method === "GET") {
    const parts = await job.documentParts();
    if (!parts) return notFound();
    return streamDocument(job, parts, url.searchParams.get("assets") === "inline");
  }
  const page = rest.match(/^pages\/(\d+)$/);
  if (page && request.method === "GET") {
    const stored = await job.page(Number(page[1]));
    return stored ? json(stored) : json({ error: "ENOENT: page not converted (yet)" }, 404);
  }
  const asset = rest.match(/^assets\/(image-[0-9a-f]{40}-\d+x\d+-png)$/);
  if (asset && request.method === "GET") {
    const size = await job.assetSize(asset[1]);
    if (size === null) return json({ error: "ENOENT: no such asset" }, 404);
    return new Response(assetStream(job, asset[1], size), {
      headers: { "content-type": "image/png", "content-length": String(size) },
    });
  }
  return json({ error: "not found" }, 404);
}

/** A byte stream re-cut into parts of exactly `size` bytes (the last one may be shorter). */
async function* inParts(body: ReadableStream<Uint8Array>, size: number) {
  let buffer = new Uint8Array(size);
  let filled = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < value.byteLength) {
      const n = Math.min(size - filled, value.byteLength - offset);
      buffer.set(value.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

/** Asset bytes are read from the job in 3 MiB pieces: a multiple of 3, so base64 pieces join. */
const ASSET_PIECE = 3 * 1024 * 1024;

type JobStub = DurableObjectStub<PdfJob>;

/** An asset as a byte stream, one piece per RPC. */
function assetStream(job: JobStub, id: string, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) return controller.close();
      const piece = await job.assetRange(id, offset, Math.min(size, offset + ASSET_PIECE));
      offset += piece.byteLength;
      controller.enqueue(piece);
    },
  });
}

/**
 * A job's document as streamed JSON: `{status, complete, document: {…, blocks, pages, assets}}`
 * (and `assets: {id: base64}` with inline assets), fetched from the job a page and an asset
 * piece at a time. Neither the RPC message limit nor this Worker's memory bounds its size.
 */
function streamDocument(
  job: JobStub,
  parts: NonNullable<Awaited<ReturnType<PdfJob["documentParts"]>>>,
  inline: boolean,
): Response {
  const language = languageByTesseract(parts.language) ?? DEFAULT_LANGUAGE;
  const {
    pages: _p,
    blocks: _b,
    assets: _a,
    ...head
  } = assembleDocument(parts.name, parts.size, language, [], [], {});
  head.source.pageCount = parts.pages.length;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (text: string) => writer.write(encoder.encode(text));
  (async () => {
    try {
      const status = { status: parts.status, complete: parts.status === "done" };
      await write(
        `${JSON.stringify(status).slice(0, -1)},"document":${JSON.stringify(head).slice(0, -1)},"blocks":[`,
      );
      const pageInfos: unknown[] = [];
      let first = true;
      for (const n of parts.pages) {
        const stored = await job.page(n);
        if (!stored) continue;
        pageInfos.push(stored.page);
        for (const block of stored.blocks) {
          await write(`${first ? "" : ","}${JSON.stringify(block)}`);
          first = false;
        }
      }
      await write(
        `],"pages":${JSON.stringify(pageInfos)},"assets":${JSON.stringify(parts.assets)}}`,
      );
      if (inline) {
        await write(`,"assets":{`);
        let firstAsset = true;
        for (const id of Object.keys(parts.assets)) {
          const size = await job.assetSize(id);
          if (size === null) continue;
          await write(`${firstAsset ? "" : ","}${JSON.stringify(id)}:"`);
          firstAsset = false;
          for (let offset = 0; offset < size; offset += ASSET_PIECE)
            await write(
              base64(await job.assetRange(id, offset, Math.min(size, offset + ASSET_PIECE))),
            );
          await write(`"`);
        }
        await write("}");
      }
      await write("}");
      await writer.close();
    } catch (e) {
      await writer.abort(e);
    }
  })();
  return new Response(readable, { headers: { "content-type": "application/json" } });
}
