// Shared by the Node suite: the model server, the app loaded with cellb, text metrics.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "@statewalker/cellb/node";

export const root = join(import.meta.dirname, "..");
export const fixture = (name: string) => readFileSync(join(root, "fixtures", name));

/**
 * Serves fixtures/models (and tesseract-core.wasm for Worker Loader isolates) over HTTP, counting
 * requests per file, so a test can tell a model read from a cell's SQLite from a download.
 */
export async function startModelServer() {
  const hits: Record<string, number> = {};
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(1));
    const file =
      name === "tesseract-core.wasm"
        ? join(root, "node_modules/tesseract-wasm/dist/tesseract-core.wasm")
        : join(root, "fixtures/models", name);
    try {
      const bytes = readFileSync(file);
      hits[name] = (hits[name] ?? 0) + 1;
      res.end(bytes);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  // cellb runs the cells on this process's event loop: OCR holds it for seconds. With Node's
  // default 5 s keep-alive, the idle-socket timer fires as soon as the loop is free and races
  // the next model download reusing that socket ("fetch failed"). Keep idle sockets longer.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/`, hits, close: () => server.close() };
}

/**
 * The app as cellb loads it on Node: wrangler.jsonc with the two vars added (cellb takes vars
 * from the configuration only), its `main` bundled with esbuild, cells' SQLite under `data`.
 */
export async function loadApp(data: string, modelBaseUrl: string) {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(text);
  delete config.$schema;
  config.main = join(root, config.main);
  config.vars = { MODEL_BASE_URL: modelBaseUrl, WASM_URL: `${modelBaseUrl}tesseract-core.wasm` };
  const dir = mkdtempSync(join(tmpdir(), "tesseract-ocr-config-"));
  writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config));
  const project = await loadProject(dir, { data });
  return {
    project,
    async fetch(path: string, init?: RequestInit) {
      return project.fetch(new Request(`http://app.test${path}`, init));
    },
    async json(path: string, init?: RequestInit) {
      const res = await project.fetch(new Request(`http://app.test${path}`, init));
      return { status: res.status, body: (await res.json()) as any };
    },
    async close() {
      await project.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type App = Awaited<ReturnType<typeof loadApp>>;

const words = (t: string) =>
  t
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/** Share of the transcript's words (as a multiset) found in the text. */
export function recall(truth: string, text: string): number {
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

/** The plain text of a PortableText document's blocks and tables. */
export const documentText = (doc: { blocks: any[] }) =>
  doc.blocks
    .map((b) =>
      b._type === "block"
        ? b.children.map((c: { text: string }) => c.text).join("")
        : b._type === "table"
          ? b.rows.map((r: { cells: string[] }) => r.cells.join(" ")).join("\n")
          : "",
    )
    .join("\n");

/** Polls a PDF job until it is no longer queued or running. */
export async function waitForJob(app: App, id: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await app.json(`/api/pdf/jobs/${id}`);
    if (body.status !== "queued" && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`job ${id}: still ${body.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
