// End to end, in Chrome, the platform's agent and shipping side (after `pnpm build`):
//
//   1. The "agent-ui" template runs: a screen that is a JSON spec in a Durable Object.
//   2. window.cellbSandbox: a script (any browser-driving agent) calls the tools: it reads
//      AGENTS.md, PUTs a new spec through http_request, and the preview shows it.
//   3. MCP: the endpoint the page's ServiceWorker hosts answers initialize, tools/list and
//      tools/call, from another tab of the origin.
//   4. The Agent tab: a scripted OpenAI-compatible model (examples/fake-openai) edits a file,
//      runs the app and checks it; the edit is in the tree and the transcript shows each tool.
//   5. Ship: Build makes the deployable folder (worker.js, wrangler.json, assets with the
//      compiled client); its ZIP is unpacked and run by cellb on Node, which answers the page,
//      the compiled module and the API.
//
// CHROME=/path/to/chrome node test/e2e-agent.mjs

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  lastUserText,
  startFakeOpenAi,
  toolResults,
} from "../../../examples/fake-openai/src/index.ts";
import { startGitServer } from "./git-server.mjs";

if (process.env.HTTPS === "1") {
  // The https run (test/e2e.mjs) checks requests on an https page; this one adds nothing there.
  console.log("e2e-agent: skipped with HTTPS=1");
  process.exit(0);
}
const PORT = Number(process.env.PORT ?? 4341);
const ORIGIN = `http://localhost:${PORT}`;
const BASE = (process.env.SANDBOX_BASE ?? "/").replace(/\/?$/, "/");
const APP = `${ORIGIN}${BASE}`;
const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const step = (t) => console.log(`• ${t}`);

const TYPES = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  json: "application/json",
  woff2: "font/woff2",
};
const server = createServer(async (req, res) => {
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
}).listen(PORT);

// The model: write a file, run the app, read the API, then answer.
const NEW_TITLE = "Edited by the agent";
// The model behind the Flue agent: in an edit run, edit the server through the capability, run
// the app, call it, answer; asked to WRITE (in a read-only run), try a write, then answer.
const fake = await startFakeOpenAi({
  reply: (req) => {
    const done = toolResults(req).length;
    if (lastUserText(req).startsWith("SCRIPT"))
      return done === 0
        ? {
            tool: "run_script",
            args: {
              code: "export default async function (files) { const names = (await files.list('/')).map((e) => e.name); await files.writeText('/generated.json', JSON.stringify({ names })); return names.length; }",
            },
          }
        : { text: `Script done: ${toolResults(req).at(-1).slice(0, 80)}` };
    if (lastUserText(req).startsWith("WRITE"))
      return done === 0
        ? { tool: "write", args: { path: "/server/sneaky.ts", content: "export {};\n" } }
        : { text: `Could not write: ${toolResults(req).at(-1).slice(0, 120)}` };
    if (done === 0)
      return {
        tool: "edit",
        args: {
          path: "/server/index.ts",
          oldText: '"A screen an agent pilots"',
          newText: JSON.stringify(NEW_TITLE),
        },
      };
    if (done === 1) return { tool: "run_app", args: {} };
    if (done === 2) return { tool: "http_request", args: { path: "api/surfaces/fresh" } };
    return { text: "The title is changed and the app runs." };
  },
});

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(APP);
  const frame = page.frameLocator('iframe[title="The running app"]');
  const showLog = async () =>
    console.log(
      await page.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
    );

  step("the agent-ui template runs");
  await page.getByRole("button", { name: /^Template: Agent UI/ }).click();
  try {
    await frame
      .getByRole("heading", { name: "A screen an agent pilots" })
      .waitFor({ timeout: 90_000 });
  } catch (err) {
    await page.getByRole("tab", { name: "Log" }).click();
    await showLog();
    throw err;
  }
  await frame.getByRole("button", { name: "+1" }).click();
  await frame.getByText("1", { exact: true }).waitFor();

  step("window.cellbSandbox: a script reads AGENTS.md and pilots the screen over HTTP");
  const scripted = await page.evaluate(async () => {
    const api = window.cellbSandbox;
    const agents = await api.call("read_file", { path: "AGENTS.md" });
    const spec = {
      root: "main",
      elements: {
        main: { type: "Stack", children: ["t", "b"] },
        t: { type: "Heading", props: { text: "Piloted by a script" } },
        b: { type: "Badge", props: { text: "live", tone: "good" } },
      },
      state: {},
    };
    const put = await api.call("http_request", {
      path: "api/surfaces/main",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    return { tools: api.tools.map((t) => t.name), agents, put, mcpUrl: api.mcpUrl };
  });
  if (!scripted.agents.ok || !scripted.agents.result.content.includes("# AGENTS.md"))
    throw new Error(`read_file AGENTS.md: ${JSON.stringify(scripted.agents)}`);
  if (scripted.put.result?.status !== 200)
    throw new Error(`PUT spec: ${JSON.stringify(scripted.put)}`);
  await frame.getByRole("heading", { name: "Piloted by a script" }).waitFor({ timeout: 10_000 });
  // The Worker's console reaches the log the tools read.
  const logged = await page.evaluate(() => window.cellbSandbox.call("read_logs", {}));
  if (!logged.result.lines.some((l) => l.text.startsWith("console.log: surface main replaced")))
    throw new Error(`no console line in the log: ${JSON.stringify(logged.result.lines.slice(-5))}`);

  step("MCP: another tab of the origin speaks MCP to the IDE");
  if (!scripted.mcpUrl) throw new Error("no MCP endpoint");
  const other = await context.newPage();
  await other.goto(`${APP}favicon.svg`);
  const mcp = await other.evaluate(async (url) => {
    const rpc = async (body) =>
      (
        await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        })
      ).json();
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const info = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "project_info", arguments: {} },
    });
    return {
      name: init.result?.serverInfo?.name,
      tools: list.result?.tools?.length,
      project: info.result?.structuredContent,
    };
  }, scripted.mcpUrl);
  if (mcp.name !== "cellb-sandbox" || !(mcp.tools >= 10) || mcp.project?.name !== "agent-ui")
    throw new Error(`MCP: ${JSON.stringify(mcp)}`);
  await other.close();

  step("the Agent tab: a Flue agent on CellB edits through its capability, runs the app, calls it");
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  const settings = panel.locator("details").first();
  if (!(await settings.evaluate((d) => d.open))) await settings.locator("summary").click();
  await panel.getByLabel("Provider").selectOption("openai");
  await panel.getByLabel("Model").fill("fake");
  await panel.getByLabel("Endpoint").fill(fake.baseUrl);
  await panel.getByLabel("API key").fill("fake-key-123");
  await panel.getByLabel("Rights", { exact: true }).selectOption("yolo");
  await panel.getByLabel("Message to the agent").fill("Rename the screen's title");
  await panel.getByRole("button", { name: "Send" }).click();
  try {
    await panel.getByText("The title is changed and the app runs.").waitFor({ timeout: 180_000 });
  } catch (err) {
    console.log(await panel.textContent());
    await page.getByRole("tab", { name: "Log" }).click();
    await showLog();
    throw err;
  }
  const calls = await panel.getByTestId("tool-call").allTextContents();
  if (calls.join(",") !== "edit,run_app,http_request") throw new Error(`tool calls: ${calls}`);
  const lastToolResult = toolResults(fake.requests.at(-1)).at(-1);
  if (!lastToolResult.includes(NEW_TITLE))
    throw new Error(`http_request result: ${lastToolResult}`);
  if (!fake.requests[0].messages[0].content.includes("<agents_md>"))
    throw new Error("AGENTS.md is not in the system prompt");
  if (!fake.authorizations.every((a) => a === "Bearer fake-key-123"))
    throw new Error(`the model key: ${fake.authorizations}`);
  // The agent's edit came back to the project (the tree, the editor, the build below).
  const mirrored = await page.evaluate(() =>
    window.cellbSandbox.call("read_file", { path: "server/index.ts" }),
  );
  if (!mirrored.result?.content.includes(NEW_TITLE))
    throw new Error(`the edit is not in the project: ${JSON.stringify(mirrored).slice(0, 300)}`);

  step("a read-only capability: the agent's write is refused, the project is unchanged");
  if (!(await settings.evaluate((d) => d.open))) await settings.locator("summary").click();
  await panel.getByLabel("Rights", { exact: true }).selectOption("readonly");
  await panel.getByLabel("Message to the agent").fill("WRITE a file");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText(/^Could not write:/).waitFor({ timeout: 120_000 });
  const statuses = await panel.getByTestId("tool-status").allTextContents();
  if (statuses.at(-1) !== "error") throw new Error(`the write's status: ${statuses}`);
  const sneaky = await page.evaluate(() =>
    window.cellbSandbox.call("list_files", { pattern: "**/sneaky.ts" }),
  );
  if (sneaky.result.files.length) throw new Error("a read-only agent wrote a file");

  step("run_script: JavaScript in a Worker Loader isolate, on the agent's capability");
  if (!(await settings.evaluate((d) => d.open))) await settings.locator("summary").click();
  await panel.getByLabel("Rights", { exact: true }).selectOption("yolo");
  await panel.getByLabel("Message to the agent").fill("SCRIPT: list the root");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText(/^Script done:/).waitFor({ timeout: 120_000 });
  for (let i = 0; ; i++) {
    const g = await page.evaluate(() =>
      window.cellbSandbox.call("read_file", { path: "generated.json" }),
    );
    if (g.ok && JSON.parse(g.result.content).names.includes("server")) break;
    if (i > 50) throw new Error(`the script's file: ${JSON.stringify(g)}`);
    await page.waitForTimeout(200);
  }

  step("other agents' tools hold their own capability: read-only refuses their writes");
  await panel.getByLabel("Rights of other agents").selectOption("readonly");
  const refused = await page.evaluate(() =>
    window.cellbSandbox.call("write_file", { path: "server/outside.ts", content: "x" }),
  );
  if (refused.ok || !/EACCES|denied/i.test(refused.error))
    throw new Error(`a read-only tool wrote: ${JSON.stringify(refused)}`);
  const stillReads = await page.evaluate(() =>
    window.cellbSandbox.call("read_file", { path: "AGENTS.md" }),
  );
  if (!stillReads.ok)
    throw new Error(`a read-only tool cannot read: ${JSON.stringify(stillReads)}`);
  await panel.getByLabel("Rights of other agents").selectOption("yolo");

  step("Ship: the deployable build (with the agent's edit), run by cellb on Node");
  await page.getByRole("tab", { name: "Ship" }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByTestId("build-files").waitFor({ timeout: 120_000 });
  const listed = await page.getByTestId("build-files").locator("li").allTextContents();
  for (const f of [
    "worker.js",
    "wrangler.json",
    "serve.mjs",
    "assets/index.html",
    "assets/_modules/~/src/main.ts.js",
    "assets/_modules/~/src/catalog.ts.js",
  ])
    if (!listed.includes(f)) throw new Error(`the build has no ${f}: ${listed.join(", ")}`);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download build .zip" }).click(),
  ]);
  const dir = await mkdtemp(join(tmpdir(), "sandbox-build-"));
  const zipPath = join(dir, "build.zip");
  await download.saveAs(zipPath);
  execFileSync("unzip", ["-q", zipPath, "-d", dir]);
  const folder = join(dir, "agent-ui-deploy");
  const out = execFileSync(
    join(root, "node_modules/.bin/tsx"),
    [
      join(root, "test/run-build.ts"),
      folder,
      "/",
      "/_modules/~/src/main.ts.js",
      "/api/surfaces/main",
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  const answers = out
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  const [home, mod, apiRes] = answers;
  if (home?.status !== 200 || !home.body.includes('_modules/~/src/main.ts.js"'))
    throw new Error(`node: / → ${JSON.stringify(home)}`);
  if (mod?.status !== 200 || !/javascript/.test(mod.type ?? ""))
    throw new Error(`node: module → ${JSON.stringify(mod)}`);
  if (apiRes?.status !== 200 || !apiRes.body.includes(NEW_TITLE))
    throw new Error(`node: api → ${JSON.stringify(apiRes)}`);
  await writeFile(join(dir, "ok"), "");

  step(
    "history: the checkpoint before the agent run restores the project; the history pushed to a git server, a commit pulled, a branch made",
  );
  await page.getByRole("tab", { name: "Ship" }).click();
  const historyPanel = page.getByTestId("history-panel");
  await historyPanel
    .getByText(/^Before the agent: Rename/)
    .first()
    .waitFor({ timeout: 60_000 });
  page.once("dialog", (d) => d.accept());
  await historyPanel
    .getByRole("button", { name: /^Restore Before the agent: Rename/ })
    .first()
    .click();
  for (let i = 0; ; i++) {
    const now = await page.evaluate(() =>
      window.cellbSandbox.call("read_file", { path: "server/index.ts" }),
    );
    if (now.ok && !now.result.content.includes(NEW_TITLE)) break;
    if (i > 100) throw new Error("the restore did not bring the file back");
    await page.waitForTimeout(200);
  }
  const hidden = await page.evaluate(() =>
    window.cellbSandbox.call("read_file", { path: ".git/HEAD" }),
  );
  if (hidden.ok) throw new Error("an outside tool read .git");

  // The history, pushed to a git server over smart HTTP (git http-backend), read back by git.
  const gitServer = await startGitServer();
  try {
    const remoteUrl = gitServer.create("agent-ui.git");
    await historyPanel.getByText("Push to a git remote").click();
    await historyPanel.getByLabel("Remote URL").fill(remoteUrl);
    await historyPanel.getByRole("button", { name: "Push", exact: true }).click();
    await historyPanel
      .getByTestId("push-status")
      .filter({ hasText: /^pushed / })
      .waitFor({ timeout: 60_000 });
    const remoteLog = gitServer.git("agent-ui.git", "log", "--format=%s", "main");
    if (!remoteLog.includes("Before the agent: Rename")) throw new Error(`git log: ${remoteLog}`);
    gitServer.git("agent-ui.git", "fsck", "--strict");

    // A commit made elsewhere (with git), pulled from the panel: the file is in the project.
    const other = await mkdtemp(join(tmpdir(), "other-"));
    const sh = (...a) =>
      execFileSync("git", ["-c", "user.name=Other", "-c", "user.email=o@x", ...a], { cwd: other });
    sh("clone", "-q", join(gitServer.root, "agent-ui.git"), ".");
    await writeFile(join(other, "FROM_ELSEWHERE.md"), "pulled\n");
    sh("add", ".");
    sh("commit", "-q", "-m", "elsewhere");
    sh("push", "-q", "origin", "main");
    await historyPanel.getByRole("button", { name: "Pull", exact: true }).click();
    await historyPanel
      .getByTestId("push-status")
      .filter({ hasText: /^pulled / })
      .waitFor({ timeout: 60_000 });
    for (let i = 0; ; i++) {
      const f = await page.evaluate(() =>
        window.cellbSandbox.call("read_file", { path: "FROM_ELSEWHERE.md" }),
      );
      if (f.ok && f.result.content === "pulled\n") break;
      if (i > 100) throw new Error(`the pulled file: ${JSON.stringify(f)}`);
      await page.waitForTimeout(200);
    }

    // A branch, made and switched to from the panel.
    await historyPanel.getByLabel("New branch").fill("experiment");
    await historyPanel.getByRole("button", { name: "New branch" }).click();
    await historyPanel
      .getByLabel("Branch")
      .locator("option", { hasText: "experiment" })
      .waitFor({ state: "attached" });
    if ((await historyPanel.getByLabel("Branch", { exact: true }).inputValue()) !== "experiment")
      throw new Error("the new branch is not current");
  } finally {
    await gitServer.close();
  }

  step(
    "a project in the browser's own storage (OPFS): opened, run, and written through a capability",
  );
  const opfsPage = await context.newPage();
  await opfsPage.goto(APP);
  await opfsPage.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const name of ["projects", "e2e-opfs"])
      dir = await dir.getDirectoryHandle(name, { create: true });
    const w = await (await dir.getFileHandle("index.html", { create: true })).createWritable();
    await w.write("<!doctype html><title>OPFS</title><h1>Kept by the browser</h1>");
    await w.close();
  });
  await opfsPage.getByLabel("Browser storage folder").fill("projects/e2e-opfs");
  await opfsPage.getByRole("button", { name: "Open from browser storage" }).click();
  await opfsPage
    .frameLocator('iframe[title="The running app"]')
    .getByRole("heading", { name: "Kept by the browser" })
    .waitFor({ timeout: 60_000 });
  const wrote = await opfsPage.evaluate(async () => {
    const r = await window.cellbSandbox.call("write_file", {
      path: "notes.md",
      content: "# via a capability",
    });
    let dir = await navigator.storage.getDirectory();
    for (const name of ["projects", "e2e-opfs"]) dir = await dir.getDirectoryHandle(name);
    const text = await (await (await dir.getFileHandle("notes.md")).getFile()).text();
    return { ok: r.ok, text };
  });
  if (!wrote.ok || wrote.text !== "# via a capability")
    throw new Error(`OPFS write: ${JSON.stringify(wrote)}`);
  await opfsPage.close();

  step(
    "notebooks: a dashboard over the Durable Object, a report written through the tools, both in the deployable build run by cellb on Node",
  );
  const nbPage = await context.newPage();
  await nbPage.goto(APP);
  await nbPage.getByRole("button", { name: /^Template: Notebook dashboard/ }).click();
  const nb = nbPage.frameLocator('iframe[title="The running app"]');
  try {
    await nb.getByRole("heading", { name: "Events dashboard" }).waitFor({ timeout: 90_000 });
    await nb.getByText(/30 events, 3 kinds/).waitFor({ timeout: 60_000 });
    await nb.getByRole("cell", { name: "signup" }).waitFor({ timeout: 60_000 });
    await nb.locator("svg").first().waitFor({ timeout: 90_000 }); // Plot, from npm
  } catch (err) {
    await nbPage.getByRole("tab", { name: "Log" }).click();
    console.log(
      await nbPage.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
    );
    throw err;
  }
  const report = await nbPage.evaluate(() =>
    window.cellbSandbox.call("write_file", {
      path: "notebooks/report.md",
      content:
        '# Weekly report\n\n```js\nconst rows = await (await fetch("../api/events")).json()\n```\n\n```js\ndisplay(`max value ${Math.max(...rows.map((r) => r.value))}`)\n```\n',
    }),
  );
  if (!report.ok) throw new Error(`report: ${JSON.stringify(report)}`);
  await nbPage
    .getByText("the files changed")
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await nbPage.getByTestId("status").waitFor({ timeout: 60_000 });
  await nbPage.getByLabel("Path in the app").fill("notebooks/report.html");
  await nbPage.getByRole("button", { name: "Reload the preview" }).click();
  await nb.getByRole("heading", { name: "Weekly report" }).waitFor({ timeout: 90_000 });
  await nb.getByText(/max value \d+/).waitFor({ timeout: 60_000 });

  // The deployable build carries the notebooks as static pages and their modules.
  await nbPage.getByRole("tab", { name: "Ship" }).click();
  await nbPage.getByRole("button", { name: "Build", exact: true }).click();
  await nbPage.getByTestId("build-files").waitFor({ timeout: 180_000 });
  const nbFiles = await nbPage.getByTestId("build-files").locator("li").allTextContents();
  for (const f of ["worker.js", "assets/notebooks/index.html", "assets/notebooks/report.html"])
    if (!nbFiles.includes(f)) throw new Error(`the build has no ${f}`);
  const runtime = nbFiles.find((f) =>
    /notebooks\/_m\/@observablehq\/notebook-kit@[^/]+\/dist\/src\/runtime\/index\.js$/.test(f),
  );
  if (!runtime) throw new Error("the build has no notebook-kit runtime");
  const [nbZip] = await Promise.all([
    nbPage.waitForEvent("download"),
    nbPage.getByRole("button", { name: "Download build .zip" }).click(),
  ]);
  const nbDir = await mkdtemp(join(tmpdir(), "sandbox-nb-build-"));
  await nbZip.saveAs(join(nbDir, "build.zip"));
  execFileSync("unzip", ["-q", join(nbDir, "build.zip"), "-d", nbDir]);
  const nbOut = execFileSync(
    join(root, "node_modules/.bin/tsx"),
    [
      join(root, "test/run-build.ts"),
      join(nbDir, "notebook-dashboard-deploy"),
      "/notebooks/", // static hosts serve index.html at the folder's URL
      `/${runtime.slice("assets/".length)}`,
      "/api/events",
    ],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );
  const [nbHome, nbRuntime, nbApi] = nbOut
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  if (nbHome?.status !== 200 || !nbHome.body.includes("Events dashboard"))
    throw new Error(`node: notebook page → ${JSON.stringify(nbHome).slice(0, 300)}`);
  if (nbRuntime?.status !== 200 || !/javascript/.test(nbRuntime.type ?? ""))
    throw new Error(`node: notebook runtime → ${JSON.stringify(nbRuntime).slice(0, 300)}`);
  if (nbApi?.status !== 200 || !nbApi.body.includes('"kind"'))
    throw new Error(`node: api → ${JSON.stringify(nbApi).slice(0, 300)}`);
  await nbPage.close();

  // S3 in the browser (any S3-compatible store whose bucket allows CORS from this origin):
  // S3_ENDPOINT=http://127.0.0.1:9200 S3_BUCKET=projects S3_KEY=… S3_SECRET=…
  if (process.env.S3_ENDPOINT) {
    step("a project in an S3 bucket: opened, run, and written through a capability");
    const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const cfg = {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET ?? "projects",
      key: process.env.S3_KEY ?? "rustfsadmin",
      secret: process.env.S3_SECRET ?? "rustfssecret",
    };
    const prefix = `e2e-${Date.now().toString(36)}`;
    const s3 = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.key, secretAccessKey: cfg.secret },
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: `${prefix}/index.html`,
        Body: "<!doctype html><title>S3</title><h1>Kept in a bucket</h1>",
        ContentType: "text/html",
      }),
    );
    const s3Page = await context.newPage();
    s3Page.on(
      "console",
      (m) => m.type() === "error" && console.log("s3 page:", m.text().slice(0, 500)),
    );
    s3Page.on(
      "response",
      (r) => r.status() >= 400 && console.log("s3 page http", r.status(), r.url()),
    );
    s3Page.on("requestfailed", (r) =>
      console.log("s3 page failed", r.url(), r.failure()?.errorText),
    );
    await s3Page.goto(APP);
    await s3Page.getByText("An S3 bucket").click();
    await s3Page.getByLabel("Endpoint (empty: AWS)", { exact: true }).fill(cfg.endpoint);
    await s3Page.getByLabel("Region", { exact: true }).fill(cfg.region);
    await s3Page.getByLabel("Bucket", { exact: true }).fill(cfg.bucket);
    await s3Page.getByLabel("Prefix (a folder in the bucket)", { exact: true }).fill(prefix);
    await s3Page.getByLabel("Access key id", { exact: true }).fill(cfg.key);
    await s3Page.getByLabel("Secret access key", { exact: true }).fill(cfg.secret);
    await s3Page.getByRole("button", { name: "Open the bucket" }).click();
    try {
      await s3Page
        .frameLocator('iframe[title="The running app"]')
        .getByRole("heading", { name: "Kept in a bucket" })
        .waitFor({ timeout: 60_000 });
    } catch (err) {
      await s3Page.screenshot({ path: process.env.FAIL_SHOT ?? "s3-failure.png" });
      await s3Page
        .getByRole("tab", { name: "Log" })
        .click()
        .catch(() => {});
      console.log(
        await s3Page.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
      );
      throw err;
    }
    const put = await s3Page.evaluate(() =>
      window.cellbSandbox.call("write_file", {
        path: "notes.md",
        content: "# via a capability, in S3",
      }),
    );
    if (!put.ok) throw new Error(`S3 write: ${JSON.stringify(put)}`);
    const got = await s3.send(
      new GetObjectCommand({ Bucket: cfg.bucket, Key: `${prefix}/notes.md` }),
    );
    const body = await got.Body.transformToString();
    if (body !== "# via a capability, in S3") throw new Error(`S3 object: ${body}`);
    await s3Page.close();
  }

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e-agent: all good");
} finally {
  await browser?.close();
  await fake.close();
  server.close();
}
