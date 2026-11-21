// The same app in Chromium: `cellb build` wrote it to browser/public/app, a Dedicated Worker loads
// it with cellb's browser loadProject (SQLite WASM on OPFS, Worker Loader isolates in workers of
// their own), and the page drives it (browser/main.ts). Models come from the Vite server, which
// counts downloads (`/__hits`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const fixtures = join(import.meta.dirname, "../../fixtures");
const base64 = (name: string) => readFileSync(join(fixtures, name)).toString("base64");

type Reply = {
  status: number;
  error?: string;
  contentType?: string;
  text?: string;
  size?: number;
  head?: number[];
};

const call = (
  page: Page,
  path: string,
  init?: { method?: string; body?: string; base64?: boolean },
) =>
  page.evaluate(([p, i]) => (window as any).__app.fetch(p, i) as Promise<Reply>, [
    path,
    init,
  ] as const);
const json = async (page: Page, path: string, init?: Parameters<typeof call>[2]) => {
  const r = await call(page, path, init);
  if (r.error) throw new Error(r.error);
  return { status: r.status, body: JSON.parse(r.text ?? "null") };
};
const post = (page: Page, path: string, file: string) =>
  json(page, path, { method: "POST", body: base64(file), base64: true });

const words = (t: string) =>
  t
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
function recall(truth: string, text: string) {
  const bag = new Map<string, number>();
  for (const w of words(text)) bag.set(w, (bag.get(w) ?? 0) + 1);
  const expected = words(truth);
  let hit = 0;
  for (const w of expected) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return hit / expected.length;
}
const documentText = (doc: { blocks: any[] }) =>
  doc.blocks
    .map((b) =>
      b._type === "block"
        ? b.children.map((c: { text: string }) => c.text).join("")
        : b._type === "table"
          ? b.rows.map((r: { cells: string[] }) => r.cells.join(" ")).join("\n")
          : "",
    )
    .join("\n");

async function waitForJob(page: Page, id: string, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await json(page, `/api/pdf/jobs/${id}`);
    if (body.status !== "queued" && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`job ${id}: still ${body.status}`);
    await page.waitForTimeout(300);
  }
}

test("the OCR app runs on cellb in a browser", async ({ page, request }) => {
  test.setTimeout(600_000);
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("Failed to load resource"))
      problems.push(m.text());
  });
  const hits = async () => (await (await request.get("/__hits")).json()) as Record<string, number>;
  const data = `ocr-${Date.now().toString(36)}`; // a fresh OPFS pool per run

  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  const started = await page.evaluate((d) => (window as any).__app.start(d), data);
  expect(started.ok, started.error).toBe(true);
  expect(started.unsupported).toEqual([]);

  await test.step("OCR in the language's cell, the model downloaded once", async () => {
    const { status, body } = await post(page, "/api/ocr?lang=eng", "c03-29.jpg");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.words.length).toBeGreaterThan(250);
    expect(body.text).toContain("Miss Watson");
    expect(body.model.source).toBe("fetch");
    expect((await hits())["eng.traineddata"]).toBe(1);
  });

  await test.step("a 2550×3300 scan in bands matches its transcript", async () => {
    const { body } = await post(page, "/api/ocr?lang=eng", "linn.png");
    expect(body.bands).toBeGreaterThan(1);
    expect(recall(readFileSync(join(fixtures, "linn.txt"), "utf8"), body.text)).toBeGreaterThan(
      0.98,
    );
  });

  await test.step("the same OCR in a Worker Loader isolate", async () => {
    const { status, body } = await post(page, "/api/ocr?lang=eng&engine=isolate", "c03-29.jpg");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.engine).toBe("isolate");
    expect(body.text).toContain("Miss Watson");
  });

  await test.step("PDF → PortableText: JBIG2 scan OCR'd, JPEG 2000, a table", async () => {
    const linn = (await post(page, "/api/pdf?lang=eng&name=linn.pdf", "linn.pdf")).body.document;
    expect(
      recall(readFileSync(join(fixtures, "linn.txt"), "utf8"), documentText(linn)),
    ).toBeGreaterThan(0.95);
    const jpx = (await post(page, "/api/pdf?lang=eng&name=l.pdf", "lichtenstein.pdf")).body
      .document;
    const img = jpx.blocks.find((b: any) => b._type === "image");
    expect([img.width, img.height]).toEqual([512, 512]);
    const paper = (await post(page, "/api/pdf?name=m.pdf", "multicolumn.pdf")).body.document;
    expect(paper.blocks.find((b: any) => b._type === "table").rows[0].cells[0]).toBe("Country");
    const geo = (await post(page, "/api/pdf?maxPages=6&name=g.pdf", "GeoTopo.pdf")).body.document;
    expect(geo.language).toBe("de");
  });

  await test.step("a PdfJob: four scanned pages at once, the PNG served", async () => {
    const { status, body } = await post(
      page,
      "/api/pdf/jobs?lang=eng&ocrCells=3&name=s.pdf",
      "scan-4.pdf",
    );
    expect(status).toBe(202);
    const done = await waitForJob(page, body.id);
    expect(done).toMatchObject({ status: "done", pagesDone: 4, failedPages: [] });
    const doc = (await json(page, `/api/pdf/jobs/${body.id}/document`)).body.document;
    const img = doc.blocks.find((b: any) => b._type === "image");
    const png = await call(page, `/api/pdf/jobs/${body.id}/assets/${img.asset._ref}`);
    expect(png.contentType).toBe("image/png");
    expect(png.head?.slice(1, 4)).toEqual([0x50, 0x4e, 0x47]);
    expect(png.size).toBe(doc.assets[img.asset._ref].size);
  });

  let pending = { id: "", pagesDone: 0 };
  await test.step("a throttled job is left half-way when the app closes", async () => {
    const { body } = await post(
      page,
      "/api/pdf/jobs?lang=deu&maxPages=20&throttleMs=1000&pageConcurrency=1&name=g.pdf",
      "GeoTopo.pdf",
    );
    for (;;) {
      const s = (await json(page, `/api/pdf/jobs/${body.id}`)).body;
      if (s.pagesDone >= 2) {
        pending = { id: body.id, pagesDone: s.pagesDone };
        break;
      }
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => (window as any).__app.stop());
  });

  await test.step("loaded again on the same OPFS storage: models stored, the job resumes", async () => {
    // A page reload: a new page and worker, the same OPFS pool.
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const again = await page.evaluate((d) => (window as any).__app.start(d), data);
    expect(again.ok, again.error).toBe(true);
    const before = await hits();
    const { body } = await post(page, "/api/ocr?lang=eng", "c03-29.jpg");
    expect(body.model.source).toBe("sqlite");
    expect((await hits())["eng.traineddata"]).toBe(before["eng.traineddata"]);
    const done = await waitForJob(page, pending.id);
    expect(done).toMatchObject({ status: "done", pagesDone: 20, failedPages: [] });
    expect(done.reads.opens).toBeGreaterThanOrEqual(2);
  });

  expect(problems).toEqual([]);
});
