import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { buildProject } from "../src/project/build.ts";
import { exportCellFiles, importCellFiles } from "../src/project/cell-files.ts";
import { loadProject } from "../src/project/node-load.ts";

// #199: a project's cells move browser → Node → browser with their data: exportCells() of an
// OPFS pool, importCellFiles into a Node data directory, exportCellFiles back, importCells into a
// fresh pool. The same object (a name's idFromName) counts on across all three.
const PKG = resolve(import.meta.dirname, "..");
const COUNTER = join(PKG, "conformance/celld-examples/counter");
const PUBLIC = join(PKG, "e2e-browser/pages/public/built");

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
type Job = {
  url: string;
  data: string;
  runs: string[][];
  importCells?: [string, string][];
  overwrite?: boolean;
  exportCells?: boolean;
};
type Result = {
  ok: boolean;
  error?: string;
  out: { body: string }[][];
  exported?: [string, string][];
};

test("cells move browser → Node → browser with their data", async ({ page }) => {
  const project = `counter-move-${Date.now().toString(36)}`;
  const out = join(PUBLIC, project);
  const dir = mkdtempSync(join(tmpdir(), "cellb-cell-move-"));
  try {
    await buildProject(COUNTER, out);
    const url = `/built/${project}/`;
    // Vite serves new public files once its watcher has seen them (statewalker/cellb.dev#212).
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) =>
        statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)],
      );
    for (const file of walk(out)) {
      const at = `${url}${relative(out, file).split("\\").join("/")}`;
      await expect
        .poll(async () => (await (await page.request.get(at)).body()).length, { timeout: 15_000 })
        .toBe(statSync(file).size);
    }
    await page.goto("/load-project/");
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    const run = async (job: Job) => {
      const r = (await page.evaluate((a) => (window as any).__loadProject(a), job)) as Result;
      expect(r.ok, r.error).toBe(true);
      return r;
    };
    const n = (r: Result) => r.out.flat().map((x) => JSON.parse(x.body).n);

    // In the browser: alpha counts to 2, beta to 1.
    const tag = Date.now().toString(36);
    const first = await run({
      url,
      data: `move-a-${tag}`,
      runs: [["/?name=alpha", "/?name=alpha", "/?name=beta"]],
      exportCells: true,
    });
    expect(n(first)).toEqual([1, 2, 1]);
    const exported = first.exported ?? [];
    expect(exported.length).toBeGreaterThan(0);

    // On Node, from those files: alpha goes on at 3.
    importCellFiles(
      dir,
      exported.map(([name, b]) => [name, bytes(b)]),
    );
    const node = await loadProject(COUNTER, { data: dir });
    const on = async (path: string) =>
      JSON.parse(await (await node.fetch(new Request(`http://localhost${path}`))).text()).n;
    expect(await on("/?name=alpha")).toBe(3);
    expect(await on("/?name=beta")).toBe(2);
    await node.close();

    // Back in a fresh browser pool, from Node's files: alpha at 4, beta at 3.
    const back = exportCellFiles(dir).filter(([p]) => p.endsWith(".sqlite"));
    const second = await run({
      url,
      data: `move-b-${tag}`,
      runs: [["/?name=alpha", "/?name=beta"]],
      importCells: back.map(([p, b]) => [p, b64(b)]),
    });
    expect(n(second)).toEqual([4, 3]);

    // A pool that holds cells refuses an import unless asked to overwrite.
    const refused = (await page.evaluate((a) => (window as any).__loadProject(a), {
      url,
      data: `move-b-${tag}`,
      runs: [["/?name=alpha"]],
      importCells: back.map(([p, b]) => [p, b64(b)]),
    })) as Result;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/already holds cells/);
    const replaced = await run({
      url,
      data: `move-b-${tag}`,
      runs: [["/?name=alpha"]],
      importCells: back.map(([p, b]) => [p, b64(b)]),
      overwrite: true,
    });
    expect(n(replaced)).toEqual([4]);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
