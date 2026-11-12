// End to end, in Chrome: the built site (astro preview), the sample, then a "local folder".
//
//   1. "Try the sample": the server (Hono + a Durable Object) is bundled and run on CellB, the
//      client (React TSX + CSS) is compiled module by module, and the client uses the server.
//   2. Rerun: the Durable Object's SQLite data survives in OPFS.
//   3. "Open folder": a folder handle (an OPFS directory standing in for the picker's answer)
//      is read, run, then changed on disk; the sandbox reruns the app with the change.
//   4. "Download .zip" gives the folder's files.
//   5. The tree folds; files are edited in CodeMirror (Ctrl+S saves and reruns), added, moved
//      and deleted: in the tab for the sample, and on disk for a picked folder.
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
  // The first visit reloads once through the ServiceWorker, which makes the page cross-origin isolated.
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30_000 });

  const status = page.getByTestId("status");
  const frame = page.frameLocator('iframe[title="The running app"]');
  const showLog = async () =>
    console.log(
      await page.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
    );

  const tree = page.getByRole("navigation", { name: "Project files" });
  const re = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // A row, by its path (its spoken name may go on: ", server", ", unsaved").
  const row = (path) => tree.getByRole("button", { name: new RegExp(`^File ${re(path)}(,|$)`) });
  const folder = (path) =>
    tree.getByRole("button", { name: new RegExp(`^Folder ${re(path)}(,|$)`) });
  // Replaces the open file's text in CodeMirror with `text`, as one input (no auto-closed
  // brackets). CodeMirror renders only the lines in view, so the text comes from the test.
  const editorText = async (text) => {
    const content = page.locator('[data-testid="code-editor"] .cm-content');
    await content.waitFor();
    await content.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
  };
  const sample = await sampleFolder();
  const fetchApp = (path) =>
    page.evaluate(async (p) => {
      const src = document.querySelector('iframe[title="The running app"]').src;
      return (await fetch(new URL(p, src))).text();
    }, path);
  const rerun = async () => {
    await page.getByRole("tab", { name: "Preview" }).click();
    await page
      .getByText("building")
      .waitFor({ state: "detached", timeout: 60_000 })
      .catch(() => {});
    await status.waitFor({ timeout: 60_000 });
  };

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

  step("the tree folds and unfolds");
  await row("client/src/main.tsx").waitFor();
  await tree.getByRole("button", { name: "Collapse client/src" }).click();
  await row("client/src/main.tsx").waitFor({ state: "detached" });
  await tree.getByRole("button", { name: "Expand client/src" }).click();
  await row("client/src/main.tsx").waitFor();
  await tree.getByRole("button", { name: "Collapse all folders" }).click();
  await row("server/index.ts").waitFor({ state: "detached" });
  // Selecting a folder opens it.
  await folder("server").click();
  await row("server/index.ts").waitFor();

  step("edit a file in CodeMirror; Ctrl+S saves it and reruns the app");
  await row("server/index.ts").click();
  await page.locator(".cm-content .cm-line").first().waitFor();
  const serverText = sample["server/index.ts"];
  if (!serverText.includes('hello: "from the server"')) throw new Error("the sample changed");
  await editorText(
    serverText.replace('hello: "from the server"', 'hello: "edited in the sandbox"'),
  );
  const unsavedRow = tree.getByRole("button", { name: /^File server\/index\.ts, .*unsaved$/ });
  await unsavedRow.waitFor();
  // Opening another project asks before an unsaved edit is dropped.
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await page.getByRole("button", { name: "Open folder" }).click();
  if (!asked.includes("Discard the unsaved changes"))
    throw new Error(`no discard prompt: ${asked}`);
  await unsavedRow.waitFor();
  // Ctrl+S saves with the focus outside the editor too.
  await folder("server").click();
  await page.keyboard.press("ControlOrMeta+S");
  await unsavedRow.waitFor({ state: "detached" });
  await rerun();
  const edited = JSON.parse(await fetchApp("api/hello"));
  if (edited.hello !== "edited in the sandbox")
    throw new Error(`api/hello: ${JSON.stringify(edited)}`);

  step("add, move (path field, drag) and delete files and folders");
  await tree.getByRole("button", { name: "New file" }).click();
  await page.getByRole("textbox", { name: "New file" }).fill("client/src/notes.md");
  await page.keyboard.press("Enter");
  await row("client/src/notes.md").waitFor();
  await row("client/src/notes.md").dragTo(folder("server"));
  await row("server/notes.md").waitFor();
  await tree.getByRole("button", { name: "Move or rename server/notes.md", exact: true }).click();
  await page.getByRole("textbox", { name: "Move or rename server/notes.md" }).fill("docs/notes.md");
  await page.keyboard.press("Enter");
  await folder("docs").waitFor();
  await tree.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "New folder" }).fill("docs");
  await page.keyboard.press("Enter");
  await tree.getByRole("alert").filter({ hasText: "already a folder" }).waitFor();
  await page.keyboard.press("Escape");
  page.once("dialog", (d) => d.accept());
  await tree.getByRole("button", { name: "Delete docs", exact: true }).click();
  await folder("docs").waitFor({ state: "detached" });
  await row("docs/notes.md").waitFor({ state: "detached" });

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
  if (zip.includes(Buffer.from("notes.md"))) throw new Error("a deleted file is in the ZIP");

  step("open a local folder (File System Access API)");
  const picked = await sampleFolder();
  picked["client/logo.bin"] = "\u0000\u0001binary\u0000";
  // The sandbox does not load node_modules; moving its folder must keep it.
  picked["docs/readme.md"] = "# Docs";
  picked["docs/node_modules/pkg/index.js"] = "export default 1;";
  picked["client/src/main.tsx"] = picked["client/src/main.tsx"].replace(
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
  }, picked);
  await page.getByRole("button", { name: "Open folder" }).click();
  try {
    await frame.getByRole("heading", { name: "My tasks" }).waitFor({ timeout: 60_000 });
  } catch (err) {
    await page.getByRole("tab", { name: "Log" }).click();
    await showLog();
    console.log("page errors:", errors);
    throw err;
  }
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

  // The picked folder's main.tsx, read from disk (OPFS stands in for it).
  const onDisk = (path) =>
    page.evaluate(async (p) => {
      let d = await (await navigator.storage.getDirectory()).getDirectoryHandle("picked");
      const parts = p.split("/");
      for (const x of parts.slice(0, -1)) d = await d.getDirectoryHandle(x);
      return (await (await d.getFileHandle(parts.at(-1))).getFile()).text();
    }, path);
  await row("client/src/main.tsx").click();
  await editorText(sample["client/src/main.tsx"].replace("<h1>Tasks</h1>", "<h1>Edited here</h1>"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await rerun();
  await frame
    .getByRole("heading", { name: "Edited here" })
    .waitFor({ timeout: 60_000 })
    .catch(async (err) => {
      await page.getByRole("tab", { name: "Log" }).click();
      await showLog();
      throw err;
    });
  if (!(await onDisk("client/src/main.tsx")).includes("<h1>Edited here</h1>"))
    throw new Error("the edit was not written to the folder");
  await tree.getByRole("button", { name: "New file" }).click();
  await page.getByRole("textbox", { name: "New file" }).fill("client/src/extra.ts");
  await page.keyboard.press("Enter");
  await row("client/src/extra.ts").waitFor();
  await tree
    .getByRole("button", { name: "Move or rename client/src/extra.ts", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Move or rename client/src/extra.ts" })
    .fill("server/extra.ts");
  await page.keyboard.press("Enter");
  await row("server/extra.ts").waitFor();
  await onDisk("server/extra.ts");
  if (
    await onDisk("client/src/extra.ts").then(
      () => true,
      () => false,
    )
  )
    throw new Error("the moved file is still at its old path on disk");
  // A folder moved on disk keeps what the sandbox did not load (node_modules).
  await tree.getByRole("button", { name: "Move or rename docs", exact: true }).click();
  await page.getByRole("textbox", { name: "Move or rename docs" }).fill("guide");
  await page.keyboard.press("Enter");
  await row("guide/readme.md").waitFor();
  if ((await onDisk("guide/node_modules/pkg/index.js")) !== "export default 1;")
    throw new Error("node_modules was not moved with its folder");
  if (
    await onDisk("docs/readme.md").then(
      () => true,
      () => false,
    )
  )
    throw new Error("the moved folder is still at its old path on disk");
  // A rename that changes only the case.
  await tree.getByRole("button", { name: "Move or rename guide/readme.md", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Move or rename guide/readme.md" })
    .fill("guide/README.md");
  await page.keyboard.press("Enter");
  await row("guide/README.md").waitFor();
  if ((await onDisk("guide/README.md")) !== "# Docs")
    throw new Error("the case-only rename lost the file");
  await row("client/logo.bin").click();
  await page.getByText("not editable here").waitFor();
  step("edits, new files and moves reach the folder on disk; a binary file is not editable");

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  await page.getByRole("tab", { name: "Log" }).click();
  await showLog();
  console.log("e2e: all good");
} finally {
  await browser?.close();
  server.close();
}
