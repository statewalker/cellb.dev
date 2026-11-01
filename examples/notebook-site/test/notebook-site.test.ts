import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { transform } from "@astrojs/compiler-rs";
import { chromium } from "@playwright/test";
import { type AstroTransform, buildAstroApp } from "@statewalker/astro-builder";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { npmPackages } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import * as esbuild from "esbuild-wasm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { crawlPages } from "../src/export.ts";
import { buildPageModels, materializeModules, type PageModel } from "../src/page-models.ts";

const here = join(import.meta.dirname, "..");

/** A directory on disk as a MemFilesApi under `prefix`. */
async function load(dir: string, prefix: string): Promise<MemFilesApi> {
  const files = new MemFilesApi();
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) =>
      statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)],
    );
  for (const f of walk(dir)) await files.write(`${prefix}/${relative(dir, f)}`, [readFileSync(f)]);
  return files;
}

/** Writes every file of `files` under `dir` on disk. */
async function save(files: FilesApi, dir: string) {
  const walk = async function* (d: string): AsyncGenerator<string> {
    for await (const e of files.list(d)) {
      if (e.kind === "directory") yield* walk(e.path);
      else yield e.path;
    }
  };
  for await (const p of walk("/")) {
    const chunks: Uint8Array[] = [];
    for await (const c of files.read(p)) chunks.push(c);
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), Buffer.concat(chunks));
  }
}

const dir = mkdtempSync(join(tmpdir(), "notebook-site-"));
let runtime: Awaited<ReturnType<typeof loadNodeProject>>["runtime"];
let pages: PageModel[];
const get = (p: string, init?: RequestInit) =>
  runtime.fetch(new Request(`http://localhost${p}`, init));
const put = (p: string, body: unknown) =>
  get(p, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeAll(async () => {
  // 1. Notebooks → page models, and the modules they import (notebook-kit's runtime, d3-format)
  //    materialized as the Worker's static assets.
  const moduleServer = newModuleServer({ cache: new MemFilesApi(), basePath: "/_m/" });
  const models = await buildPageModels({
    notebooks: await load(join(here, "notebooks"), ""),
    moduleServer,
    siteTitle: "Notebooks on cellb",
  });
  pages = models.pages;
  const assets = new MemFilesApi();
  await materializeModules(models.pins, moduleServer, assets);

  // 2. The theme: an Astro project built by astro-builder into one Worker module.
  const built = await buildAstroApp({
    esbuild,
    transform: transform as unknown as AstroTransform,
    files: await load(join(here, "theme"), "/theme"),
    root: "/theme",
    packages: npmPackages(),
  });
  for (const [path, bytes] of built.clientAssets) await assets.write(path, [bytes]);

  // 3. Worker + KV + assets on cellb in Node; the page models go in through the edit endpoints.
  writeFileSync(join(dir, "worker.js"), built.code);
  await save(assets, join(dir, "assets"));
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: "notebook-site",
      main: "worker.js",
      compatibility_date: "2026-02-24",
      compatibility_flags: ["nodejs_compat"],
      kv_namespaces: [{ binding: "NOTEBOOKS", id: "notebooks" }],
      assets: { directory: "assets" },
    }),
  );
  const loaded = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
  });
  expect(loaded.unsupported).toEqual([]);
  runtime = loaded.runtime;
  expect((await put("/api/site", models.site)).status).toBe(204);
  for (const page of pages) expect((await put(`/api/notebooks/${page.id}`, page)).status).toBe(204);
}, 600_000);

afterAll(async () => {
  await runtime?.close();
});

it("derives page models from Markdown notebooks", () => {
  expect(pages.map((p) => [p.id, p.path, p.title])).toEqual([
    ["index", "/", "Notebooks on cellb"],
    ["guide/numbers", "/guide/numbers", "Formatting numbers"],
  ]);
  const numbers = pages[1];
  expect(numbers.outline.map((o) => [o.depth, o.slug])).toEqual([
    [1, "formatting-numbers"],
    [2, "importing-a-package"],
    [2, "using-it"],
    [3, "a-note"],
  ]);
  expect(numbers.blocks.filter((b) => b.kind === "cell")).toHaveLength(2);
  expect(numbers.script).toMatch(
    /^import \{define\} from "\/_m\/@observablehq\/notebook-kit@[^/]+\/dist\//,
  );
  expect(numbers.script).toMatch(/"\/_m\/d3-format@[^"]+"/); // the npm: import, pinned
});

it("renders each notebook through the Astro theme", async () => {
  const numbers = pages.find((p) => p.id === "guide/numbers") as PageModel;
  const res = await get("/guide/numbers");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("<title>Formatting numbers · Notebooks on cellb</title>");
  // navigation from the site model, the current page marked; the table of contents
  expect(html).toMatch(/<a href="\/guide\/numbers" aria-current="page">Formatting numbers<\/a>/);
  expect(html).toContain('<a href="/">Notebooks on cellb</a>');
  expect(html).toContain('<a href="#importing-a-package">Importing a package</a>');
  // prose with heading ids, a root per code cell, the define() script verbatim
  expect(html).toContain('<h2 id="using-it">Using it</h2>');
  expect(html.match(/<div id="cell-\d+" class="cell">/g)).toHaveLength(2);
  expect(html).toContain(`<script type="module">${numbers.script}</script>`);
  expect(html).toContain(`<link rel="stylesheet" href="${numbers.stylesUrl}">`);

  expect((await get("/")).status).toBe(200);
  expect((await get("/no/such/notebook")).status).toBe(404);
  // the modules are the Worker's static assets
  const runtimeUrl = /from "([^"]+)"/.exec(numbers.script)?.[1] as string;
  const runtimeModule = await get(runtimeUrl);
  expect(runtimeModule.status).toBe(200);
  expect(runtimeModule.headers.get("content-type")).toMatch(/javascript/);
  expect((await get(numbers.stylesUrl)).status).toBe(200);
});

it("serves an edited notebook without rebuilding the theme", async () => {
  const index = pages.find((p) => p.id === "index") as PageModel;
  const edited = {
    ...index,
    title: "Notebooks, edited",
    blocks: [{ kind: "prose", html: "<p>Edited after the build.</p>" }, ...index.blocks],
  };
  expect((await put("/api/notebooks/index", edited)).status).toBe(204);
  const html = await (await get("/")).text();
  expect(html).toContain("<title>Notebooks, edited · Notebooks on cellb</title>");
  expect(html).toContain("<p>Edited after the build.</p>");
  expect((await put("/api/notebooks/index", index)).status).toBe(204);
});

it("exports a static site whose cells run in Chromium", async () => {
  // Pages by crawling the running Worker; modules from the materialized closure (assets/).
  const exported = await crawlPages((r) => runtime.fetch(r), { skip: /^\/api\// });
  expect([...exported.keys()].filter((k) => k.endsWith(".html")).sort()).toEqual([
    "guide/numbers/index.html",
    "index.html",
  ]);
  const out = join(dir, "export");
  await save(await load(join(dir, "assets"), ""), out);
  for (const [path, bytes] of exported) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), bytes);
  }

  // A plain static file server: nothing of the Worker, cellb or Astro runs any more.
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = join(out, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executablePath =
    process.env.PW_CHROMIUM ||
    (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch(
    executablePath ? { executablePath, args: ["--no-sandbox"] } : {},
  );
  try {
    const page = await browser.newPage();
    const offOrigin: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(base)) offOrigin.push(r.url());
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${base}/`);
    await expect
      .poll(() => page.locator(".cell").nth(1).innerText(), { timeout: 30_000 })
      .toContain("42");
    await page.goto(`${base}/guide/numbers`);
    await expect
      .poll(() => page.locator(".cell").nth(1).innerText(), { timeout: 30_000 })
      .toContain("1,234,567.89");
    expect(errors).toEqual([]);
    expect(offOrigin).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
});
