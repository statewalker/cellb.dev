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
import { startFakeOpenAi, toolResults } from "../../../examples/fake-openai/src/index.ts";

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
const fake = await startFakeOpenAi({
  reply: (req) => {
    const done = toolResults(req).length;
    if (done === 0)
      return {
        tool: "edit_file",
        args: {
          path: "server/index.ts",
          old_text: '"A screen an agent pilots"',
          new_text: JSON.stringify(NEW_TITLE),
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

  step("the Agent tab: a model edits the server, runs the app and calls it");
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  const settings = panel.locator("details").first();
  if (!(await settings.evaluate((d) => d.open))) await settings.locator("summary").click();
  await panel.getByLabel("Provider").selectOption("openai");
  await panel.getByLabel("Model").fill("fake");
  await panel.getByLabel("Endpoint").fill(fake.baseUrl);
  await panel.getByLabel("Message to the agent").fill("Rename the screen's title");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText("The title is changed and the app runs.").waitFor({ timeout: 90_000 });
  const calls = await panel.getByTestId("tool-call").allTextContents();
  if (calls.join(",") !== "edit_file,run_app,http_request") throw new Error(`tool calls: ${calls}`);
  const lastToolResult = toolResults(fake.requests.at(-1)).at(-1);
  if (!lastToolResult.includes(NEW_TITLE))
    throw new Error(`http_request result: ${lastToolResult}`);
  if (!fake.requests[0].messages[0].content.includes("<agents_md>"))
    throw new Error("AGENTS.md is not in the system prompt");

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

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e-agent: all good");
} finally {
  await browser?.close();
  await fake.close();
  server.close();
}
