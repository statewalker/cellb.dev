// PROTOTYPE (statewalker/statewalker-root#236): the browser seam. Builds the demo page, serves it,
// and reads what each cell shows in headless Chromium.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPage } from "../src/build.ts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

let server: Server;
let url: string;
let browser: import("playwright").Browser;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-proto-"));
  const result = await buildPage(join(import.meta.dirname, "..", "page", "index.md"), dir);
  expect(result.errors).toEqual([]);
  server = createServer(async (req, res) => {
    const path = join(dir, req.url === "/" ? "index.html" : (req.url ?? "").slice(1));
    try {
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  return { page, errors };
}

describe("the demo page in a browser", () => {
  it("runs the ts cell and fills the inline expression in the prose", async () => {
    const { page, errors } = await open();
    await expect.poll(() => page.locator("p", { hasText: "There are" }).textContent()).toBe("There are 3 doors.");
    expect(errors).toEqual([]);
  });

  it("mounts the jsx cell's shadcn Button with React, and it reacts to clicks", async () => {
    const { page, errors } = await open();
    const button = page.locator('[data-slot="button"]');
    await expect.poll(() => button.textContent()).toBe("Clicked 3 times");
    await button.click();
    await expect.poll(() => button.textContent()).toBe("Clicked 4 times");
    expect(errors).toEqual([]);
  });

  it("renders the tsx cell's table from a real @statewalker/fsm config", async () => {
    const { page, errors } = await open();
    const rows = page.locator("table.transitions tbody tr");
    await expect.poll(() => rows.count()).toBe(3);
    expect(await rows.allTextContents()).toEqual(["(initial)*Closed", "ClosedopenOpen", "OpencloseClosed"]);
    expect(errors).toEqual([]);
  });

  it("shows a run=false fence as code and does not run it", async () => {
    const { page, errors } = await open();
    await expect.poll(() => page.locator("pre code").last().textContent()).toContain("startProcesses({ modules: [] });");
    expect(errors).toEqual([]);
  });
});
