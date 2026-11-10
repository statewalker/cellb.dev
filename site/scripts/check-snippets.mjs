// Runs the home page's Durable Object code as a reader would copy it:
//
//   1. Node: src/demo/counter/serve-node.ts (the "Node" tab), started on the demo's project;
//      two requests for one name must count 1, then 2, and another name must start at 1.
//   2. Browser: the built home page in Chromium; the demo (the "Browser" tab's files: tabs.ts,
//      sw.ts, shard-worker.ts, with public/built/demo-counter from `cellb build`) must answer
//      from the tab's own shards, and count on.
//
//   pnpm build && pnpm check:snippets            (serves dist/ on a port of its own)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const SITE = new URL("..", import.meta.url).pathname;
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

// 1. Node
{
  const cwd = mkdtempSync(join(tmpdir(), "cellb-snippet-")); // its ./data
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tsx = createRequire(join(SITE, "package.json")).resolve("tsx/cli");
  const child = spawn(
    process.execPath,
    [
      tsx,
      join(SITE, "src/demo/counter/serve-node.ts"),
      join(SITE, "src/demo/counter/project"),
      String(port),
    ],
    { cwd, stdio: ["ignore", "inherit", "inherit"] },
  );
  const get = async (name) => {
    for (let i = 0; ; i++) {
      try {
        return await (await fetch(`http://127.0.0.1:${port}/?name=${name}`)).json();
      } catch (e) {
        if (i > 100) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };
  try {
    const a1 = await get("alice");
    const a2 = await get("alice");
    const b1 = await get("bob");
    check(
      a1.n === 1 && a2.n === 2 && b1.n === 1,
      `node: serve-node.ts counts per object (${JSON.stringify([a1, a2, b1])})`,
    );
  } catch (e) {
    check(false, `node: serve-node.ts answers (${e})`);
  } finally {
    child.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}

// 2. Browser: dist/ as a static host serves it.
{
  const DIST = join(SITE, "dist");
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  const server = createServer(async (req, res) => {
    let file = join(DIST, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    const n = page.locator('[data-demo-n="alice"]');
    await page.click('[data-demo-send="alice"]');
    await page.waitForFunction(
      () => document.querySelector('[data-demo-n="alice"]')?.textContent === "1",
      null,
      { timeout: 60_000 },
    );
    await page.click('[data-demo-send="alice"]');
    await page.waitForFunction(
      () => document.querySelector('[data-demo-n="alice"]')?.textContent === "2",
      null,
      { timeout: 30_000 },
    );
    check(
      (await n.textContent()) === "2" && !errors.length,
      `browser: the demo counts 1, then 2, from the tab's shards${errors.length ? ` (page errors: ${errors.join("; ")})` : ""}`,
    );
  } catch (e) {
    check(false, `browser: the demo answers (${String(e).split("\n")[0]})`);
  } finally {
    await browser?.close();
    server.close();
  }
}

process.exit(failures.length ? 1 : 0);
