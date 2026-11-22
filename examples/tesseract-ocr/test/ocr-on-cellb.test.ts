// The OCR app on cellb in Node: Tesseract in Durable Objects (and in Worker Loader isolates),
// PDF → PortableText in the Worker and in PdfJob objects, then a restart on the same data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type App,
  documentText,
  fixture,
  loadApp,
  recall,
  startModelServer,
  waitForJob,
  waitForPages,
} from "./app.ts";

const data = mkdtempSync(join(tmpdir(), "tesseract-ocr-data-"));
let models: Awaited<ReturnType<typeof startModelServer>>;
let app: App;
/** A throttled job started before the restart, finished after it. */
let pending: { id: string; pagesDone: number } | undefined;

const post = (path: string, file: string) =>
  app.json(path, { method: "POST", body: fixture(file) });

beforeAll(async () => {
  models = await startModelServer();
  app = await loadApp(data, models.baseUrl);
});
afterAll(async () => {
  await app?.close();
  await models?.close();
  rmSync(data, { recursive: true, force: true });
});

describe("OCR in Durable Objects", () => {
  it("loads with nothing unsupported, Worker Loader offered", async () => {
    expect(app.project.unsupported).toEqual([]);
    const { body } = await app.json("/api/runtime");
    expect(body.workerLoader).toBe(true);
  });

  it("reads a JPEG book page in the language's cell", async () => {
    const { status, body } = await post("/api/ocr?lang=eng", "c03-29.jpg");
    expect(status).toBe(200);
    expect(body.cellName).toBe("ocr-eng");
    expect(body.words.length).toBeGreaterThan(250);
    expect(body.text).toContain("Miss Watson");
  });

  it("reads a 2550×3300 two-column scan in bands, matching its transcript", async () => {
    const { body } = await post("/api/ocr?lang=eng", "linn.png");
    expect(body.bands).toBeGreaterThan(1);
    expect(recall(fixture("linn.txt").toString(), body.text)).toBeGreaterThan(0.98);
  });

  it("reads a Dutch page with the Dutch model in a cell of its own", async () => {
    const { status, body } = await post("/api/ocr?lang=nld", "typewriter.png");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.cellName).toBe("ocr-nld");
    expect(body.text).toContain("Linzensoep");
  });

  it("runs the same OCR in a Worker Loader isolate", async () => {
    const { body } = await post("/api/ocr?lang=eng&engine=isolate", "c03-29.jpg");
    expect(body.engine).toBe("isolate");
    expect(body.text).toContain("Miss Watson");
  });

  it("refuses bad input: not an image, a decompression bomb, thin bands", async () => {
    expect((await app.json("/api/ocr?lang=eng", { method: "POST", body: "x" })).status).toBe(400);
    const bomb = new Uint8Array(33);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(bomb.buffer).setUint32(16, 60000);
    new DataView(bomb.buffer).setUint32(20, 60000);
    expect((await app.json("/api/ocr?lang=eng", { method: "POST", body: bomb })).status).toBe(413);
    expect((await post("/api/ocr?lang=eng&band=1", "baiona_gray.png")).status).toBe(400);
  });
});

describe("PDF → PortableText in the Worker", () => {
  const images = (doc: { blocks: any[] }) => doc.blocks.filter((b) => b._type === "image");

  it("lays out a two-column LaTeX paper with its table", async () => {
    const { body } = await post("/api/pdf?lang=auto&name=multicolumn.pdf", "multicolumn.pdf");
    const tables = body.document.blocks.filter((b: any) => b._type === "table");
    expect(body.document.pages).toHaveLength(3);
    expect(tables[0].rows[0].cells[0]).toBe("Country");
  });

  it("decodes a JBIG2 scan and OCRs it, word boxes inside the image", async () => {
    const { body } = await post("/api/pdf?lang=eng&name=linn.pdf", "linn.pdf");
    const [img] = images(body.document);
    expect(recall(fixture("linn.txt").toString(), documentText(body.document))).toBeGreaterThan(
      0.95,
    );
    for (const b of body.document.blocks.filter((x: any) => x._type === "block"))
      for (const m of b.markDefs) expect(m.bbox.x + m.bbox.width).toBeLessThanOrEqual(img.width);
  });

  it("decodes JPEG 2000 with pdf.js's OpenJPEG wasm", async () => {
    const { body } = await post("/api/pdf?lang=eng&name=lichtenstein.pdf", "lichtenstein.pdf");
    const [img] = images(body.document);
    expect([img.width, img.height]).toEqual([512, 512]);
  });

  it("detects German from the text layer and keeps bold", async () => {
    const { body } = await post("/api/pdf?maxPages=6&name=GeoTopo.pdf", "GeoTopo.pdf");
    expect(body.document.language).toBe("de");
    const strong = body.document.blocks
      .flatMap((b: any) => (b._type === "block" ? b.children : []))
      .filter((s: any) => s.marks.includes("strong"));
    expect(strong.length).toBeGreaterThanOrEqual(3);
  });

  it("streams one NDJSON event per page", async () => {
    const res = await app.fetch("/api/pdf?lang=eng&stream=1&assets=inline&name=c03-29.pdf", {
      method: "POST",
      body: fixture("c03-29.pdf"),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["page", "end"]);
    expect(Buffer.from(events[0].assets[0].png, "base64").subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("PDF jobs: a PdfJob Durable Object per document", () => {
  const start = (file: string, query: Record<string, string> = {}) =>
    app.json(`/api/pdf/jobs?${new URLSearchParams({ name: file, ...query })}`, {
      method: "POST",
      body: fixture(file),
    });

  it("converts 117 pages, a batch per alarm", async () => {
    const { status, body } = await start("GeoTopo.pdf");
    expect(status).toBe(202);
    const done = await waitForJob(app, body.id);
    expect(done).toMatchObject({ status: "done", pageCount: 117, pagesDone: 117, failedPages: [] });
    expect(done.alarms).toBe(Math.ceil(117 / 4));
    const doc = (await app.json(`/api/pdf/jobs/${body.id}/document`)).body;
    expect(doc.complete).toBe(true);
    expect(doc.document.pages).toHaveLength(117);
  });

  it("OCRs four scanned pages at once over three cells; serves the PNG", async () => {
    const { body } = await start("scan-4.pdf", { lang: "eng", ocrCells: "3" });
    const done = await waitForJob(app, body.id);
    expect(done).toMatchObject({ status: "done", pagesDone: 4, failedPages: [] });
    const doc = (await app.json(`/api/pdf/jobs/${body.id}/document`)).body.document;
    const img = doc.blocks.find((b: any) => b._type === "image");
    const png = await app.fetch(`/api/pdf/jobs/${body.id}/assets/${img.asset._ref}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await png.arrayBuffer()).byteLength).toBe(doc.assets[img.asset._ref].size);
  });

  it("streams a 34 MB upload in and reads only what the pages need", async () => {
    const size = fixture("big-34mb.pdf").length;
    const { body } = await start("big-34mb.pdf", { lang: "deu" });
    expect(body.size).toBe(size);
    const done = await waitForJob(app, body.id);
    expect(done.pagesDone).toBe(3);
    expect(done.reads.bytesRead).toBeLessThan(size / 10);
  });

  it("leaves a throttled job half-way for the restart", async () => {
    const { body } = await start("GeoTopo.pdf", {
      lang: "deu",
      maxPages: "30",
      throttleMs: "1000",
      pageConcurrency: "1",
    });
    const s = await waitForPages(app, body.id, 2);
    pending = { id: body.id, pagesDone: s.pagesDone };
  });
});

describe("after a restart on the same data", () => {
  beforeAll(async () => {
    await app.close();
    app = await loadApp(data, models.baseUrl);
  });

  it("reads the models from the cells' SQLite, not the network", async () => {
    const before = { ...models.hits };
    const { body } = await post("/api/ocr?lang=nld", "typewriter.png");
    expect(body.model.source).toBe("sqlite");
    expect(models.hits["nld.traineddata"]).toBe(before["nld.traineddata"]);
  });

  it("resumes the job left half-way and finishes it", async () => {
    if (!pending) throw new Error("no job was left running");
    const done = await waitForJob(app, pending.id);
    expect(done).toMatchObject({ status: "done", pagesDone: 30, failedPages: [] });
    expect(done.reads.opens).toBeGreaterThanOrEqual(2);
    const doc = (await app.json(`/api/pdf/jobs/${pending.id}/document`)).body.document;
    expect(doc.pages.map((p: { number: number }) => p.number)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});
