// Observable Framework in containers, as layers (examples/observable-framework): a Lifo build
// container with egress installs Framework into a FilesApi and adapts its CLI; Lifo containers
// without network build sites on that layer (read-only base, a copy-on-write layer per run).
// Needs the npm registry and jsDelivr for the build step.
import { MessageChannel, Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { cow, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  frameworkBuild,
  frameworkBuildSteps,
  frameworkLayerFiles,
  frameworkPreview,
  helloSite,
} from "../examples/observable-framework/recipe.ts";
import { createContainer } from "../src/container.ts";
import { HostMounts, serveHostFiles } from "../src/files/bridge.ts";
import { createIsolatedPool, type IsolatedPool } from "../src/isolated-pool.ts";
import { connectEngine } from "../src/rpc.ts";
import { containerWebSocket } from "../src/websocket.ts";

const env = { HOME: "/home/user", OBSERVABLE_TELEMETRY_DISABLE: "true" };
const spawn = (egress: "none" | "host") => () =>
  new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url), {
    workerData: { egress },
  });
const site = async (files: Record<string, string>) => {
  const top = new MemFilesApi();
  for (const [path, content] of Object.entries(files)) await writeText(top, `/${path}`, content);
  return top;
};

describe("Observable Framework in Lifo containers (Node)", { timeout: 600_000 }, () => {
  const layer = new MemFilesApi(); // the base layer being built
  let runs: IsolatedPool;

  beforeAll(async () => {
    for (const [path, content] of Object.entries(frameworkLayerFiles("/data")))
      await writeText(layer, `/${path}`, content);
    runs = createIsolatedPool({ spawn: spawn("none"), image: { packages: [], env }, size: 1 });
  });
  afterAll(async () => {
    await runs?.close();
  });

  it("build step: a container with egress installs Framework into the layer and adapts it", async () => {
    const build = createIsolatedPool({
      spawn: spawn("host"),
      image: { packages: [], env, enableInternet: true },
      size: 1,
    });
    try {
      for (const argv of frameworkBuildSteps("/data")) {
        const r = await build.run({ argv, files: layer, cwd: "/data", timeoutMs: 600_000 });
        expect(r.exitCode, `${argv.join(" ")}\n${r.stderr}`).toBe(0);
      }
    } finally {
      await build.close();
    }
    const pkg = await readText(layer, "/node_modules/@observablehq/framework/package.json");
    expect(JSON.parse(pkg).version).toBe("1.13.4");
    expect(await layer.exists("/src/.observablehq/cache/_npm")).toBe(true);
    expect(await layer.exists("/src/index.md")).toBe(false); // the warm-up page is gone
  });

  it("runs without network build a site on the read-only layer, each in its own layer", async () => {
    const top = await site(helloSite);
    const r = await runs.run({
      argv: frameworkBuild("/data"),
      files: cow(readOnly(layer), top),
      cwd: "/data",
      timeoutMs: 300_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/render \/index → dist\/index\.html/);
    const html = await readText(top, "/dist/index.html");
    expect(html).toMatch(/<h1 id="hello-from-a-container"[\s\S]*Hello from a container<\/a><\/h1>/);
    expect(html).toContain("One plus one is");

    // another site, another layer: nothing of the first one, and the base is unchanged
    const other = await site({ "src/about.md": "# About\n" });
    const r2 = await runs.run({
      argv: frameworkBuild("/data"),
      files: cow(readOnly(layer), other),
      cwd: "/data",
      timeoutMs: 300_000,
    });
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(await readText(other, "/dist/about.html")).toMatch(/<h1 id="about"/);
    expect(await other.exists("/dist/index.html")).toBe(false);
    expect(await layer.exists("/dist")).toBe(false);
  });

  it("a site importing an npm module the layer has not cached needs network", async () => {
    const top = await site({
      "src/index.md": '```js\nimport confetti from "npm:canvas-confetti";\n```\n',
    });
    const r = await runs.run({
      argv: frameworkBuild("/data"),
      files: cow(readOnly(layer), top),
      cwd: "/data",
      timeoutMs: 300_000,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no egress.*registry\.npmjs\.org\/canvas-confetti/);
  });
  it("preview with live reload: the page's socket reaches the server in the container", async () => {
    // Lifo runs one command at a time: the server is the container's entrypoint (a background
    // job), so commands still run beside it. A container of its own, with the layers mounted.
    const worker = new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url));
    const engineChannel = new MessageChannel();
    const filesChannel = new MessageChannel();
    const mounts = new HostMounts();
    serveHostFiles(filesChannel.port1, mounts);
    worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
      engineChannel.port2,
      filesChannel.port2,
    ]);
    const top = await site({ "src/index.md": "# Live\n\nversion one\n" });
    const c = createContainer(connectEngine(engineChannel.port1), {
      packages: [],
      env,
      mounts: [{ path: "/data", id: mounts.add(cow(readOnly(layer), top)) }],
      workdir: "/data",
    });
    try {
      await c.start({ entrypoint: frameworkPreview("/data", 3000) });
      await c.waitForPort?.(3000, 60_000);
      const html = await (await c.getTcpPort(3000).fetch("http://container/")).text();
      expect(html).toContain("version one");
      const hash = html.match(/open\(\{hash: "([^"]+)"/)?.[1];
      expect(hash).toBeTruthy();

      // what the page's live-reload client does, with a WebSocket class into the container
      const WS = containerWebSocket(c, 3000);
      const ws = new WS("ws://container/_observablehq") as unknown as WebSocket;
      const messages: { type: string; html?: unknown }[] = [];
      const next = (type: string) =>
        new Promise<{ type: string; html?: unknown }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no ${type} message`)), 30_000);
          const check = () => {
            const m = messages.find((x) => x.type === type);
            if (m) {
              clearTimeout(timer);
              resolve(m);
            } else setTimeout(check, 50);
          };
          check();
        });
      ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", path: "/", hash }));
      await next("welcome");

      // an edit inside the container: Framework's watcher sees it and pushes an update
      const edit = await c.exec([
        "node",
        "-e",
        "require('fs').writeFileSync('src/index.md', '# Live\\n\\nversion two\\n')",
      ]);
      expect(edit.exitCode, edit.stderr).toBe(0);
      const update = await next("update");
      expect(JSON.stringify(update.html)).toContain("version two");
      expect(await readText(top, "/src/index.md")).toContain("version two"); // in the run's layer
      ws.close();
    } finally {
      await c.destroy();
      await worker.terminate();
    }
  });
});
