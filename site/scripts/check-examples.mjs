// Runs every example page of the built site in Chromium, as a visitor would: opens
// /examples/<name>/, presses Run, and reads the summary. Fails when an example that is not a
// known difference gives an answer other than the recorded one, or when any run fails.
//
//   pnpm build && pnpm check:examples            (serves dist/ on a port of its own)
//   pnpm check:examples kv counter               (some examples only)

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const examples = JSON.parse(
  readFileSync(new URL("../src/generated/examples.json", import.meta.url), "utf8"),
);
const only = process.argv.slice(2);
const list = examples.filter((e) => !only.length || only.includes(e.name));

// dist/ as a static host serves it (`astro preview` runs as a daemon in recent Astro versions).
const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const failures = [];
let next = 0;
async function lane() {
  while (next < list.length) {
    const e = list[next++];
    const context = await browser.newContext(); // an OPFS of its own
    const page = await context.newPage();
    let status;
    try {
      await page.goto(`${base}/examples/${e.name}/`);
      await page.click("[data-run-button]");
      await page.waitForFunction(
        () =>
          /answers the same|failed/.test(
            document.querySelector("[data-run-status]")?.textContent ?? "",
          ),
        null,
        { timeout: (e.seconds + 60) * 1000 },
      );
      status = await page.textContent("[data-run-status]");
    } catch (err) {
      status = `failed: ${err.message.split("\n")[0]}`;
    }
    const m = /^(\d+) of (\d+) /.exec(status ?? "");
    const same = !!m && m[1] === m[2];
    const ok = m && (same || e.knownGap);
    console.log(`${ok ? "ok  " : "FAIL"} ${e.name}: ${status}`);
    if (!ok) failures.push(e.name);
    await context.close();
  }
}
try {
  await Promise.all(Array.from({ length: 6 }, lane));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} example(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${list.length} examples ran`);
