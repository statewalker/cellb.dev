// End to end, in Chrome: the built site (astro preview), the sample, then a "local folder".
//
//   1. "Try the sample": the server (Hono + a Durable Object) is bundled and run on CellB, the
//      client (React TSX + CSS) is compiled module by module, and the client uses the server.
//   2. Rerun: the Durable Object's SQLite data survives in OPFS.
//   3. "Open folder": a folder handle (an OPFS directory standing in for the picker's answer)
//      is read, run, then changed on disk; the sandbox reruns the app with the change.
//   4. "Download .zip" gives the folder's files.
//
// CHROME=/path/to/chrome node test/e2e.mjs   (default: Playwright's own Chromium)
// SANDBOX_BASE=/sandbox/app/ for a build made with that base (as cellb.dev serves it): the site is
// then served under that path only, as on cellb.dev.
// HTTPS=1 serves it over https (a self-signed certificate made with openssl), as cellb.dev does:
// requests reach the page's handlers through webrun-http-browser, which before 0.12.5 rebuilt
// them as http://, so on https no request reached its handler.

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 4339);
const HTTPS = process.env.HTTPS === "1";
const ORIGIN = `${HTTPS ? "https" : "http"}://localhost:${PORT}`;
const BASE = (process.env.SANDBOX_BASE ?? "/").replace(/\/?$/, "/");
const APP = `${ORIGIN}${BASE}`;
const root = new URL("..", import.meta.url).pathname;

function step(text) {
  console.log(`• ${text}`);
}

async function waitFor(url, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer`);
}

async function sampleFolder() {
  const dir = join(root, "sample/tasks");
  const out = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[relative(dir, p)] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  return out;
}

// The built site (npm run build), served as a static host would.
const TYPES = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  json: "application/json",
  woff2: "font/woff2",
};
const dist = join(root, "dist");
async function tlsOptions() {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-e2e-"));
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  return { key: await readFile(key), cert: await readFile(cert) };
}
const listener = async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  if (!path.startsWith(BASE)) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  path = `/${path.slice(BASE.length)}`;
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(dist, path));
    res.setHeader("content-type", TYPES[path.split(".").pop()] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
};
const server = (
  HTTPS ? createHttpsServer(await tlsOptions(), listener) : createHttpServer(listener)
).listen(PORT);
let browser;
try {
  // The server is in this process; over https, Node's fetch would refuse its certificate.
  if (!HTTPS) await waitFor(`${APP}sw-worker.js`);
  browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    // The self-signed certificate: a ServiceWorker registers only where the certificate is trusted.
    args: HTTPS ? ["--ignore-certificate-errors"] : [],
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: HTTPS });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);

  const status = page.getByTestId("status");
  const frame = page.frameLocator('iframe[title="The running app"]');
  const showLog = async () =>
    console.log(
      await page.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
    );

  step("try the sample");
  await page.getByRole("button", { name: "Try the sample" }).click();
  try {
    await status.waitFor({ timeout: 120_000 });
  } catch (err) {
    await page.getByRole("tab", { name: "Log" }).click();
    await showLog();
    throw err;
  }
  await frame.getByRole("heading", { name: "Tasks" }).waitFor({ timeout: 60_000 });
  step("the client (React TSX, CSS) is up");

  const color = await frame
    .locator("button[type=submit]")
    .evaluate((el) => getComputedStyle(el).borderRadius);
  if (color !== "6px") throw new Error(`the client's CSS did not apply (${color})`);

  await frame.getByLabel("New task").fill("Write the demo");
  await frame.getByRole("button", { name: "Add" }).click();
  await frame.getByText("Write the demo").waitFor();
  await frame.getByLabel("New task").fill("Ship it");
  await frame.getByRole("button", { name: "Add" }).click();
  await frame
    .getByText("1 of 2 left")
    .waitFor({ state: "detached" })
    .catch(() => {});
  await frame.getByText("2 of 2 left").waitFor();
  await frame.getByRole("checkbox").first().click();
  await frame.getByText("1 of 2 left").waitFor();
  step("the client calls the server: tasks added and toggled in a Durable Object");

  const hello = await page.evaluate(async () => {
    const src = document.querySelector('iframe[title="The running app"]').src;
    return (await fetch(new URL("api/hello", src))).json();
  });
  if (hello.hello !== "from the server") throw new Error(`api/hello: ${JSON.stringify(hello)}`);
  step("the server answers the page too (any tab of the origin can open the app)");

  await page.getByRole("button", { name: "Rerun" }).click();
  await page
    .getByText("building")
    .waitFor({ state: "detached", timeout: 60_000 })
    .catch(() => {});
  await status.waitFor({ timeout: 60_000 });
  await frame.getByText("1 of 2 left").waitFor({ timeout: 60_000 });
  step("rerun: the Durable Object's SQLite data is still there");

  step("download the app as a ZIP");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download .zip" }).click(),
  ]);
  const zipPath = await download.path();
  const zip = await readFile(zipPath);
  if (download.suggestedFilename() !== "tasks.zip") throw new Error(download.suggestedFilename());
  if (!zip.includes(Buffer.from("tasks/wrangler.jsonc")))
    throw new Error("no wrangler.jsonc in the ZIP");
  if (!zip.includes(Buffer.from("tasks/client/src/main.tsx")))
    throw new Error("no main.tsx in the ZIP");

  step("open a local folder (File System Access API)");
  const folder = await sampleFolder();
  folder["client/src/main.tsx"] = folder["client/src/main.tsx"].replace(
    "<h1>Tasks</h1>",
    "<h1>My tasks</h1>",
  );
  await page.evaluate(async (files) => {
    const opfs = await navigator.storage.getDirectory();
    await opfs.removeEntry("picked", { recursive: true }).catch(() => {});
    const dir = await opfs.getDirectoryHandle("picked", { create: true });
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    window.showDirectoryPicker = async () => dir;
  }, folder);
  await page.getByRole("button", { name: "Open folder" }).click();
  await frame.getByRole("heading", { name: "My tasks" }).waitFor({ timeout: 60_000 });
  step("the folder runs");

  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle("picked");
    const src = await (await dir.getDirectoryHandle("client")).getDirectoryHandle("src");
    const fh = await src.getFileHandle("main.tsx");
    const text = (await (await fh.getFile()).text()).replace(
      "<h1>My tasks</h1>",
      "<h1>Saved on disk</h1>",
    );
    await new Promise((r) => setTimeout(r, 1100)); // a new lastModified
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  });
  await frame.getByRole("heading", { name: "Saved on disk" }).waitFor({ timeout: 60_000 });
  step("a change on disk reruns the app");

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  await page.getByRole("tab", { name: "Log" }).click();
  await showLog();
  console.log("e2e: all good");
} finally {
  await browser?.close();
  server.close();
}
