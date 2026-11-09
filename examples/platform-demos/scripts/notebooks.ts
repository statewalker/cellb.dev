/**
 * The notebooks demo: demos/notebooks (a Markdown notebook and an Observable Notebook Kit HTML
 * document) sent to the platform, compiled to pages in a NotebookSite object, and opened in
 * Chromium, where their cells run with d3 and Observable Plot from the platform's module server.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromiumOptions } from "../../../packages/platform/scripts/chromium.js";

type Check = (host: string, name: string, fn: () => Promise<string>) => Promise<boolean>;
interface Tools {
  check: Check;
  assert: (cond: unknown, msg: string) => asserts cond;
  browserOn: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Playwright is untyped here
  playwright: () => any;
}

const dir = resolve(import.meta.dirname, "../notebooks");

export async function notebooksDemo(host: string, base: string, t: Tools) {
  const { check, browserOn, playwright } = t;
  const assert: Tools["assert"] = t.assert;
  const site = `${base}/nb/demo`;
  const built = await check(host, "notebooks: compiled to pages in a Durable Object", async () => {
    const files: Record<string, string> = {};
    for (const n of readdirSync(dir)) files[n] = readFileSync(join(dir, n), "utf8");
    const imp = await fetch(`${site}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    assert(imp.ok, `import ${imp.status}`);
    const r = await fetch(`${site}/build`, { method: "POST" });
    const body = await r.text();
    assert(r.ok, `build ${r.status}: ${body.slice(0, 500)}`);
    const res = JSON.parse(body) as {
      pages: string[];
      failures: { notebook: string; error: string }[];
      ms: number;
    };
    assert(
      res.pages.includes("/plots.html") && res.pages.includes("/index.html"),
      `pages ${res.pages}`,
    );
    assert(res.failures.length === 0, `failures ${JSON.stringify(res.failures)}`);
    const page = await (await fetch(`${site}/plots.html`)).text();
    assert(page.includes("/nb/demo/_m/"), "the page does not import from the module server");
    return `${res.pages.length} pages in ${res.ms} ms`;
  });
  if (!built || !browserOn) return;
  await check(host, "notebooks: cells run in Chromium (d3, Plot, Inputs)", async () => {
    const b = await playwright().chromium.launch(chromiumOptions());
    try {
      const page = await b.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${site}/plots.html`);
      await page.waitForSelector("#summary", { timeout: 60000 });
      const summary = await page.textContent("#summary");
      assert(summary?.includes("60 points"), `summary: ${summary}`);
      await page.waitForSelector("svg", { timeout: 30000 });
      const dots = await page.$$eval("svg circle", (c: Element[]) => c.length);
      assert(dots === 60, `Plot drew ${dots} dots`);
      // The range input drives the other cells.
      await page.fill('input[type="number"]', "100");
      await page.press('input[type="number"]', "Enter");
      await page.waitForFunction(
        () => document.querySelector("#summary")?.textContent?.includes("100 points"),
        null,
        { timeout: 15000 },
      );
      await page.goto(`${site}/index.html`);
      await page.waitForSelector("svg", { timeout: 60000 });
      assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
      return "Plot drew 60 dots, the input re-ran the cells (100 points); index.md rendered";
    } finally {
      await b.close();
    }
  });
}
