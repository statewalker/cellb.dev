// PROTOTYPE (statewalker/statewalker-root#236): the browser seam. Builds the demo page, serves it,
// and reads what each cell shows in headless Chromium.
import { mkdtempSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPage } from "../src/build.ts";
import { createModuleServer } from "../src/modules.ts";
import { serveSite } from "../src/site.ts";

const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

let server: Server;
let url: string;
let browser: import("playwright").Browser;

let dist: string;
const requests: string[] = [];

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "nb-proto-"));
  const modules = createModuleServer();
  const result = await buildPage(join(import.meta.dirname, "..", "page", "index.md"), dist, { modules });
  expect(result.errors).toEqual([]);
  server = serveSite(dist, modules);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function open() {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push(r.url()));
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
    const button = page.locator('[data-slot="button"]', { hasText: "Clicked" });
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

  it("re-runs the cells that read a Mutable when it changes", async () => {
    const { page, errors } = await open();
    const button = () => page.locator('[data-slot="button"]', { hasText: "Mutable clicks" });
    await expect.poll(() => button().textContent()).toBe("Mutable clicks: 0");
    await button().click();
    await expect.poll(() => button().textContent()).toBe("Mutable clicks: 1");
    expect(errors).toEqual([]);
  });

  it("loads a notebook-kit built-in library from local packages, never from esm.sh", async () => {
    const { page, errors } = await open();
    await expect.poll(() => page.locator("b.from-htl").textContent(), { timeout: 20_000 }).toBe("Rendered by htl");
    expect(requests.filter((u) => u.includes("esm.sh"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("bundles the page's own code minified, without notebook-kit's runtime", () => {
    expect(statSync(join(dist, "page.js")).size).toBeLessThan(400_000);
  });

  it("runs from a plain static server once /_m/ is exported as files", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "nb-static-"));
    const modules = createModuleServer();
    const result = await buildPage(join(import.meta.dirname, "..", "page", "index.md"), staticDir, { modules, exportModules: true });
    expect(result.errors).toEqual([]);
    const plain = serveSite(staticDir); // no module server behind /_m/
    await new Promise<void>((r) => plain.listen(0, r));
    const page = await browser.newPage();
    const errors: string[] = [];
    const seen: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => seen.push(r.url()));
    await page.goto(`http://localhost:${(plain.address() as { port: number }).port}/`);
    await expect.poll(() => page.locator("b.from-htl").textContent(), { timeout: 20_000 }).toBe("Rendered by htl");
    await expect.poll(() => page.locator("table.transitions tbody tr").count()).toBe(3);
    expect(seen.filter((u) => !u.startsWith("http://localhost"))).toEqual([]);
    expect(errors).toEqual([]);
    plain.close();
  }, 60_000);
});
