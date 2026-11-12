// Screenshots of the sandbox's main flows (after `pnpm build`), driven with the scripted model:
//   node test/screenshots.mjs <out-dir>
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  lastUserText,
  startFakeOpenAi,
  toolResults,
} from "../../../examples/fake-openai/src/index.ts";

const out = process.argv[2] ?? "screenshots";
const PORT = 4352;
const APP = `http://localhost:${PORT}/`;
const dist = new URL("../dist", import.meta.url).pathname;
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
  let p = decodeURIComponent(new URL(req.url, APP).pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = await readFile(join(dist, p));
    res.setHeader("content-type", TYPES[p.split(".").pop()] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
}).listen(PORT);

const fake = await startFakeOpenAi({
  delayMs: 300,
  reply: (req) => {
    const done = toolResults(req).length;
    if (lastUserText(req).startsWith("Add a note")) {
      if (done === 0) return { tool: "read", args: { path: "/AGENTS.md" } };
      if (done === 1)
        return {
          tool: "write",
          args: {
            path: "/plans/notes-feature.md",
            content: "# Notes feature\n\n- a Notes card on the screen\n",
          },
        };
      return { text: "I can only plan here: the plan is in /plans/notes-feature.md." };
    }
    if (done === 0)
      return { tool: "grep", args: { pattern: "A screen an agent pilots", path: "/server" } };
    if (done === 1)
      return {
        tool: "edit",
        args: {
          path: "/server/index.ts",
          oldText: '"A screen an agent pilots"',
          newText: '"Piloted by a Flue agent"',
        },
      };
    if (done === 2) return { tool: "run_app", args: {} };
    if (done === 3) return { tool: "http_request", args: { path: "api/surfaces/demo" } };
    return {
      text: "Done: the title is now “Piloted by a Flue agent”. I ran the app and checked GET api/surfaces/demo.",
    };
  },
});

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({
  viewport: { width: 1360, height: 860 },
  deviceScaleFactor: 2,
});
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`• ${name}`);
};
try {
  await page.goto(APP);
  // The first visit reloads once through the ServiceWorker, which makes the page cross-origin isolated.
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30_000 });
  await page.getByRole("button", { name: /^Template: Agent UI/ }).waitFor();
  await shot("01-welcome-sources");

  await page.getByRole("button", { name: /^Template: Agent UI/ }).click();
  const frame = page.frameLocator('iframe[title="The running app"]');
  await frame
    .getByRole("heading", { name: "A screen an agent pilots" })
    .waitFor({ timeout: 90_000 });
  await frame.getByRole("button", { name: "+1" }).click();
  await frame.getByRole("button", { name: "+1" }).click();
  await frame.getByRole("textbox").fill("Capabilities filter the real files");
  await frame.getByRole("button", { name: "Add" }).click();
  await shot("02-preview-running");

  const tree = page.getByRole("navigation", { name: "Project files" });
  await tree.getByRole("button", { name: /^File server\/index\.ts/ }).click();
  await shot("03-code-editor");

  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  const settings = panel.locator("details").first();
  if (!(await settings.evaluate((d) => d.open))) await settings.locator("summary").click();
  await panel.getByLabel("Provider").selectOption("openai");
  await panel.getByLabel("Model").fill("scripted-model");
  await panel.getByLabel("Endpoint").fill(fake.baseUrl);
  await panel.getByLabel("API key").fill("demo-key-1234");
  await panel.getByLabel("Rights", { exact: true }).selectOption("yolo");
  await shot("04-agent-settings");
  await settings.locator("summary").click();
  await panel
    .getByLabel("Message to the agent")
    .fill("Rename the screen's title to “Piloted by a Flue agent”, then run and check it.");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText(/^Done: the title/).waitFor({ timeout: 120_000 });
  await panel.locator("details").filter({ hasText: "edit" }).last().locator("summary").click();
  await shot("05-agent-flue-run");

  await settings.locator("summary").click();
  await panel.getByLabel("Rights", { exact: true }).selectOption("plan");
  await settings.locator("summary").click();
  await panel.getByLabel("Message to the agent").fill("Add a note: plan it");
  await panel.getByRole("button", { name: "Send" }).click();
  await panel.getByText(/^I can only plan here/).waitFor({ timeout: 120_000 });
  await shot("06-agent-plan-mode");

  // The `main` surface keeps the state the clicks above saved: a fresh one shows the new title.
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Path in the app").fill("?surface=fresh");
  await page.getByRole("button", { name: "Reload the preview" }).click();
  await frame
    .getByRole("heading", { name: "Piloted by a Flue agent" })
    .waitFor({ timeout: 90_000 });
  await tree.getByRole("button", { name: /^File plans\/notes-feature\.md/ }).click();
  await shot("07-agent-changes-in-project");

  await page.getByRole("tab", { name: "Ship" }).click();
  await page
    .getByTestId("history-panel")
    .getByText(/^Before the agent: Add a note/)
    .waitFor({ timeout: 60_000 });
  await shot("08-history-checkpoints");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page.getByTestId("build-files").waitFor({ timeout: 120_000 });
  await page.getByTestId("build-files").locator("summary").click();
  await page.getByRole("button", { name: "Build", exact: true }).scrollIntoViewIfNeeded();
  await shot("09-ship-build");

  await page.getByRole("tab", { name: "Log" }).click();
  await shot("10-log");

  await page.setViewportSize({ width: 400, height: 860 });
  await page.getByRole("tab", { name: "Agent" }).click();
  await shot("11-phone-agent");
} finally {
  await browser.close();
  await fake.close();
  server.close();
}
