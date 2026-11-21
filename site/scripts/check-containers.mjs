// Checks the containers demos as the site publishes them (dist/demos/containers/, built by
// scripts/build-containers-demos.mjs from packages/containers/examples/browser-demos), served by a
// plain file server that sends no COOP/COEP headers, as the static host does: the demos'
// ServiceWorker must give each page cross-origin isolation.
//   - python/ (Wasmer): a script runs in a fresh Python container against the page's files, with
//     no network, and the next run sees nothing of it;
//   - notebook/ (Lifo): a build container installs Observable Framework through the page's network,
//     and the preview updates live when the notebook is edited.
//
//   pnpm build && pnpm check:containers            (serves dist/ on a port of its own)
//   DEMOS_DIST=<dir> pnpm check:containers         (serves <dir> at /demos/containers/)
//
// Needs the Wasmer registry, the npm registry, jsDelivr and unpkg, and Chromium (PW_CHROMIUM to use
// a given one).
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const APP = "/demos/containers/";
const SITE = new URL("..", import.meta.url).pathname;
const ROOT = process.env.DEMOS_DIST ?? join(SITE, "dist", APP);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".py": "text/plain",
  ".csv": "text/csv",
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (!path.startsWith(APP)) return void res.writeHead(404).end();
  let file = join(ROOT, normalize(decodeURIComponent(path.slice(APP.length))));
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
const url = `http://127.0.0.1:${server.address().port}${APP}`;

const proxy = process.env.HTTPS_PROXY
  ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }
  : undefined;
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  proxy,
});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
try {
  const landing = await browser.newPage();
  await landing.goto(url);
  const links = await landing.$$eval(".card h2 a", (as) => as.map((a) => a.getAttribute("href")));
  check(
    JSON.stringify(links) === JSON.stringify(["./python/", "./notebook/"]),
    "the landing page links both demos",
  );
  await landing.close();

  // Wasmer: Python
  const py = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  py.on("pageerror", (e) => console.log("pageerror (python):", e.message));
  await py.goto(`${url}python/`);
  await py.waitForFunction(
    () => ["ready", "error"].includes(document.body.dataset.state ?? ""),
    null,
    {
      timeout: 300_000,
    },
  );
  console.log("python:", await py.textContent("#status"));
  check(await py.evaluate(() => crossOriginIsolated), "python: the page is cross-origin isolated");
  check((await py.getAttribute("body", "data-state")) === "ready", "python: a container is ready");
  const runOnce = async () => {
    await py.click("#run");
    await py.waitForFunction(
      () => !document.querySelector("#run").disabled && document.body.dataset.state !== "busy",
      null,
      { timeout: 120_000 },
    );
    return { out: await py.textContent("#output"), files: await py.textContent("#files") };
  };
  const first = await runOnce();
  console.log(first.out.trim());
  check(/Python 3\.\d+/.test(first.out), "python: the script runs in Python");
  check(
    first.out.includes("5 cities") && first.out.includes("hottest: Cairo"),
    "python: it reads the page's file at /data",
  );
  check(
    first.files.includes("/summary.txt") && first.files.includes("hottest=Cairo"),
    "python: the file it writes lands in the page's FilesApi",
  );
  check(/network: none/.test(first.out), "python: the container has no network");
  await py.fill(
    "#code",
    "import os; print(sorted(os.listdir('/data')), os.path.exists('/tmp/left-over'))\nopen('/tmp/left-over','w').write('x')",
  );
  const second = await runOnce();
  const third = await runOnce();
  check(
    second.out.trim() === "['temperatures.csv'] False" &&
      third.out.trim() === "['temperatures.csv'] False",
    "python: each run is a fresh container (nothing left from the last run)",
  );
  await py.close();

  // Lifo: the notebook
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => console.log("pageerror (notebook):", e.message));
  await page.goto(`${url}notebook/`);
  await page.waitForFunction(
    () => ["ready", "error"].includes(document.body.dataset.state ?? ""),
    null,
    { timeout: 300_000 },
  );
  const status = await page.textContent("#status");
  console.log("notebook:", status);
  console.log((await page.textContent("#log")).trim());
  check(
    await page.evaluate(() => crossOriginIsolated),
    "notebook: the page is cross-origin isolated",
  );
  check((await page.getAttribute("body", "data-state")) === "ready", `notebook: ready (${status})`);

  const frame = page.frameLocator("#preview");
  await frame.locator("h1").waitFor({ timeout: 30_000 });
  check(
    (await frame.locator("h1").textContent()) === "Wave explorer",
    "notebook: the preview shows the notebook",
  );
  await frame.locator('input[type="range"]').first().fill("6");
  await frame.getByText(Math.sin(6).toFixed(3)).waitFor({ timeout: 15_000 });
  check(true, "notebook: a slider drives the notebook");

  const edited = (await page.inputValue("#editor")).replace(
    "# Wave explorer",
    "# Wave explorer, edited live",
  );
  await page.fill("#editor", edited);
  await frame.getByText("Wave explorer, edited live").waitFor({ timeout: 30_000 });
  check(
    (await frame.locator('input[type="range"]').first().inputValue()) === "6",
    "notebook: an edit updates the preview in place (the slider keeps its value)",
  );
} catch (e) {
  check(false, String(e));
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("the containers demos work");
