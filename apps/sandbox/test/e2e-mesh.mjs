// End to end, the sandbox published over HTTPeers (after `pnpm build`), on the public relay
// (relay.httpeers.net; RELAY_DOC for another one):
//
//   1. The hub (apps/sandbox-hub, its own process) reserves on the relay and prints a link.
//   2. A sandbox tab opens the link: it joins the mesh as a publisher and runs the sample.
//   3. A bridge (a Node member, its own process) with an editor's invitation serves it at
//      localhost: the published sandbox is listed, its app answers, its MCP endpoint reads and
//      writes the project (the write shows in the tab).
//   4. A bridge with a viewer's invitation opens the app and is refused the MCP endpoint.
//   5. Ship to the hub: the tab deploys its build; the hub runs it on CellB and the viewer's bridge
//      opens it (/h/<name>/), its page and its Durable Object's API.
//   6. The public gateway (in the hub's process): nothing until the tab turns Public on; then its
//      app and a public deploy, for anyone, and never the MCP tools.
//
// CHROME=/path/to/chrome node test/e2e-mesh.mjs

import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 4345);
const APP = `http://localhost:${PORT}/`;
const root = new URL("..", import.meta.url).pathname;
const hubRoot = join(root, "../sandbox-hub");
const dist = join(root, "dist");
const step = (t) => console.log(`• ${t}`);
const TYPES = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  json: "application/json",
};
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, APP).pathname);
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

const procs = [];
/** Runs a sandbox-hub command; resolves with the first line matching `ready`. */
function run(args, env, ready) {
  const p = spawn(join(hubRoot, "node_modules/.bin/tsx"), args, {
    cwd: hubRoot,
    env: { ...process.env, ...env },
  });
  procs.push(p);
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${args.join(" ")}: no "${ready}" in 90 s:\n${out}`)),
      90_000,
    );
    const onData = (d) => {
      out += d;
      const m = out.match(ready);
      if (m) {
        clearTimeout(timer);
        resolve({ p, m, out: () => out });
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("exit", (code) => code && reject(new Error(`${args.join(" ")} exited ${code}:\n${out}`)));
  });
}
async function oneShot(args, env) {
  const p = spawn(join(hubRoot, "node_modules/.bin/tsx"), args, {
    cwd: hubRoot,
    env: { ...process.env, ...env },
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => p.on("exit", r));
  if (code) throw new Error(`${args.join(" ")}: ${out}`);
  return out;
}

let browser;
try {
  const hubDir = await mkdtemp(join(tmpdir(), "sandbox-hub-"));
  const GATEWAY = `http://127.0.0.1:${PORT + 10}/`;
  const hubEnv = {
    SANDBOX_HUB_DIR: hubDir,
    SANDBOX_URL: APP,
    SANDBOX_HUB_GATEWAY_PORT: String(PORT + 10),
    ...(process.env.RELAY_DOC ? { SANDBOX_HUB_RELAY_DOC: process.env.RELAY_DOC } : {}),
  };
  const hub = await run(["src/main.ts", "start"], hubEnv, /READY (\S+)/);
  const link = hub.out().match(/(http:\/\/\S+\?join=\S+)/)[1];
  step(`the hub ${hub.m[1].slice(-8)} is up on the relay; its publisher link opens the sandbox`);

  browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(link);
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Try the sample" }).click();
  const frame = page.frameLocator('iframe[title="The running app"]');
  await frame.getByRole("heading").first().waitFor({ timeout: 90_000 });
  await page.getByRole("tab", { name: "Ship" }).click();
  const status = page.getByTestId("publish-status");
  try {
    await status.getByText(/^Published \(direct/).waitFor({ timeout: 90_000 });
  } catch (err) {
    console.log("publish status:", await status.textContent());
    await page.getByRole("tab", { name: "Log" }).click();
    console.log(
      await page.evaluate(() => document.querySelector('[data-testid="log"]')?.textContent),
    );
    throw err;
  }
  const peerId = (await status.textContent()).match(/12D3\w+/)[0];
  if (page.url().includes("join=")) throw new Error("the spent invitation is still in the URL");
  step(`the tab is published: ${peerId.slice(-8)}, a direct link to the hub`);
  if (process.env.SHOT) {
    await page.getByTestId("publish-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.SHOT });
  }

  const blobOf = (out) => out.match(/blob \(the bridge\):\s+(\S+)/)[1];
  const editorInv = blobOf(await oneShot(["src/main.ts", "invite", "editor"], hubEnv));
  const editor = await run(
    ["src/bridge.ts", editorInv],
    {
      SANDBOX_BRIDGE_DIR: await mkdtemp(join(tmpdir(), "sandbox-bridge-")),
      SANDBOX_BRIDGE_PORT: "0",
    },
    /bridge: (http:\/\/127\.0\.0\.1:\d+\/) /,
  );
  const B = editor.m[1];
  step(`an editor's bridge joined: ${B}`);

  // The mesh view reaches the bridge with the hub's heartbeat.
  let home = "";
  for (let i = 0; i < 60 && !home.includes(peerId); i++) {
    home = await (await fetch(B)).text();
    if (!home.includes(peerId)) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!home.includes(peerId)) throw new Error(`the bridge does not list the sandbox: ${home}`);
  const app = await fetch(`${B}s/${peerId}/app/`);
  const html = await app.text();
  if (app.status !== 200 || !/<html|<!doctype/i.test(html))
    throw new Error(`app over the mesh: ${app.status} ${html.slice(0, 200)}`);
  const api = await fetch(`${B}s/${peerId}/app/api/lists/demo/tasks`);
  step(`the bridge lists the sandbox and serves its app (page ${app.status}, API ${api.status})`);

  const rpc = async (base, body) => {
    const r = await fetch(`${base}mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json().catch(() => null) };
  };
  const init = await rpc(B, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  if (init.value?.result?.serverInfo?.name !== "cellb-sandbox")
    throw new Error(`initialize: ${JSON.stringify(init)}`);
  const listed = await rpc(B, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = listed.value.result.tools.map((t) => t.name);
  if (!names.includes("write_file")) throw new Error(`an editor's tools: ${names}`);
  const agents = await rpc(B, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "AGENTS.md" } },
  });
  if (!agents.value?.result?.structuredContent?.content)
    throw new Error(`read_file: ${JSON.stringify(agents.value)}`);
  const wrote = await rpc(B, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "write_file",
      arguments: { path: "from-the-mesh.md", content: "# written by a remote agent" },
    },
  });
  if (wrote.value?.result?.isError) throw new Error(`write_file: ${JSON.stringify(wrote.value)}`);
  const inTab = await page.evaluate(() =>
    window.cellbSandbox.call("read_file", { path: "from-the-mesh.md" }),
  );
  if (!inTab.ok || !inTab.result.content.includes("remote agent"))
    throw new Error(`the write in the tab: ${JSON.stringify(inTab)}`);
  const git = await rpc(B, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "list_files", arguments: { pattern: ".cellb/**" } },
  });
  if (git.value?.result?.structuredContent?.files?.length)
    throw new Error("a remote agent sees the history");
  step("MCP over the mesh: an editor's agent reads AGENTS.md and writes a file the tab shows");

  const viewerInv = blobOf(await oneShot(["src/main.ts", "invite", "viewer"], hubEnv));
  const viewer = await run(
    ["src/bridge.ts", viewerInv],
    {
      SANDBOX_BRIDGE_DIR: await mkdtemp(join(tmpdir(), "sandbox-bridge-")),
      SANDBOX_BRIDGE_PORT: "0",
    },
    /bridge: (http:\/\/127\.0\.0\.1:\d+\/) /,
  );
  const V = viewer.m[1];
  const vApp = await fetch(`${V}s/${peerId}/app/`);
  const vMcp = await fetch(`${V}s/${peerId}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (vApp.status !== 200 || vMcp.status !== 403)
    throw new Error(`a viewer: app ${vApp.status}, MCP ${vMcp.status}`);
  step("a viewer's bridge opens the app and is refused the MCP endpoint (403)");

  await page.getByRole("button", { name: "Deploy to the hub" }).click();
  try {
    await page.getByTestId("hosted-apps").getByText("tasks").waitFor({ timeout: 180_000 });
  } catch (err) {
    await page.getByRole("tab", { name: "Log" }).click();
    console.log(
      await page.evaluate(() =>
        document.querySelector('[data-testid="log"]')?.textContent?.slice(-3000),
      ),
    );
    throw err;
  }
  if (process.env.SHOT_DEPLOY) {
    await page.getByTestId("hub-host").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.SHOT_DEPLOY });
  }
  const hostedPage = await fetch(`${V}h/tasks/`);
  const hostedHtml = await hostedPage.text();
  if (hostedPage.status !== 200 || !/<html|<!doctype/i.test(hostedHtml))
    throw new Error(`the hosted app: ${hostedPage.status} ${hostedHtml.slice(0, 200)}`);
  const hostedApi = await fetch(`${V}h/tasks/api/lists/demo/tasks`);
  if (hostedApi.status !== 200)
    throw new Error(`the hosted API: ${hostedApi.status} ${await hostedApi.text()}`);
  const listing = await (await fetch(V)).text();
  if (!listing.includes('href="/h/tasks/"'))
    throw new Error("the bridge does not list the hosted app");
  step(
    "Ship to the hub: the tab deployed its build; the hub runs it on CellB; a viewer opens its page and API",
  );

  // The public gateway: anyone, no invitation. Nothing is public yet.
  const gw = (path, init) => fetch(`${GATEWAY}${path}`, init);
  if ((await gw(`s/${peerId}/app/`)).status !== 404)
    throw new Error("the gateway serves a tab that is not public");
  if ((await gw("h/tasks/")).status !== 404)
    throw new Error("the gateway serves a deploy that is not public");
  await page.getByLabel("Public", { exact: true }).check();
  let pubApp = 0;
  for (let i = 0; i < 90 && pubApp !== 200; i++) {
    pubApp = (await gw(`s/${peerId}/app/`)).status;
    if (pubApp !== 200) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pubApp !== 200) throw new Error(`the public tab through the gateway: ${pubApp}`);
  const json = { "content-type": "application/json" };
  const pubApi = await gw(`s/${peerId}/app/api/lists/demo/tasks`);
  const pubMcp = await gw(`s/${peerId}/mcp`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const pubMcp2 = await gw("mcp", { method: "POST", headers: json, body: "{}" });
  if (pubApi.status !== 200 || pubMcp.status !== 404 || pubMcp2.status !== 404)
    throw new Error(`public: api ${pubApi.status}, mcp ${pubMcp.status}/${pubMcp2.status}`);
  await page.getByRole("button", { name: "Deploy to the hub" }).click();
  await page
    .getByTestId("hosted-apps")
    .getByText(/public/)
    .waitFor({ timeout: 180_000 });
  const pubHosted = await gw("h/tasks/");
  if (pubHosted.status !== 200)
    throw new Error(`the public deploy through the gateway: ${pubHosted.status}`);
  const gwHome = await (await gw("")).text();
  if (
    !gwHome.includes(`/s/${peerId}/app/`) ||
    !gwHome.includes("/h/tasks/") ||
    gwHome.includes("MCP")
  )
    throw new Error(`the gateway's page: ${gwHome.slice(0, 400)}`);
  step(
    "the public gateway: nothing until Public is on; then the tab's app and the public deploy for anyone, never MCP",
  );

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e-mesh: all good");
} finally {
  await browser?.close();
  for (const p of procs) p.kill("SIGTERM");
  server.close();
}
process.exit(0);
