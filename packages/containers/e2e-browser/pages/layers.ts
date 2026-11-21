// Layered files in a page: a Lifo build container with egress (through the page's network)
// installs into a FilesApi owned by this thread; containers without network run on it read-only.
import { readText, writeText } from "@statewalker/webrun-files";
import { CompositeFilesApi, cow, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  frameworkBuild,
  frameworkBuildSteps,
  frameworkLayerFiles,
  frameworkPreview,
  helloSite,
} from "../../examples/observable-framework/recipe.ts";
import { createContainer } from "../../src/container.ts";
import { HostMounts, serveHostFiles } from "../../src/files/bridge.ts";
import { createIsolatedPool } from "../../src/isolated-pool.ts";
import { connectEngine } from "../../src/rpc.ts";
import { containerWebSocket } from "../../src/websocket.ts";

/** Framework's layer, once built by __framework (the preview reuses it). */
let frameworkLayer: MemFilesApi | undefined;
async function buildFrameworkLayer() {
  const layer = await filesOf(frameworkLayerFiles("/data"));
  const build = buildPool();
  const steps: { argv: string; exitCode: number; ms: number; stderr: string }[] = [];
  try {
    for (const argv of frameworkBuildSteps("/data")) {
      const r = await build.run({ argv, files: layer, cwd: "/data", timeoutMs: 600_000 });
      steps.push({
        argv: argv.join(" "),
        exitCode: r.exitCode,
        ms: r.ms,
        stderr: r.stderr.slice(-1500),
      });
      if (r.exitCode !== 0) return { layer: undefined, steps };
    }
  } finally {
    await build.close();
  }
  frameworkLayer = layer;
  return { layer, steps };
}

const env = { HOME: "/home/user", OBSERVABLE_TELEMETRY_DISABLE: "true" };
const buildPool = () =>
  createIsolatedPool({
    spawn: () =>
      new Worker(new URL("./isolated-lifo-egress-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [], env, enableInternet: true },
    size: 1,
  });
const runPool = () =>
  createIsolatedPool({
    spawn: () =>
      new Worker(new URL("./isolated-lifo-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [], env },
    size: 1,
  });
const node = (code: string) => ["node", "-e", code];
const filesOf = async (files: Record<string, string>) => {
  const fs = new MemFilesApi();
  for (const [path, content] of Object.entries(files)) await writeText(fs, `/${path}`, content);
  return fs;
};

Object.assign(window, {
  async __layers() {
    const deps = await filesOf({
      "package.json": JSON.stringify({ name: "app", dependencies: { ms: "2.1.3" } }),
    });
    const build = buildPool();
    const t0 = performance.now();
    const install = await build.run({ argv: ["npm", "install"], files: deps, cwd: "/data" });
    const installMs = Math.round(performance.now() - t0);
    await build.close();
    const installed = JSON.parse(await readText(deps, "/node_modules/ms/package.json")).version;

    const runs = runPool();
    const layered = () =>
      new CompositeFilesApi(new MemFilesApi()).mount(
        "/node_modules",
        readOnly(deps),
        "/node_modules",
      );
    const a = layered();
    const first = await runs.run({
      argv: node(`
        const fs = require("fs");
        const ms = require("/data/node_modules/ms");
        fs.writeFileSync("/data/out.txt", ms(90000));
        let refused = "no";
        try { fs.writeFileSync("/data/node_modules/ms/index.js", "tampered"); } catch (e) { refused = e.code; }
        console.log(JSON.stringify({ result: ms(90000), refused }));
      `),
      files: a,
    });
    const out = await readText(a, "/out.txt");
    const second = await runs.run({
      argv: node(
        `const fs = require("fs"); console.log(JSON.stringify([fs.existsSync("/data/out.txt"), require("/data/node_modules/ms")(1000)]))`,
      ),
      files: layered(),
    });
    const top = new MemFilesApi();
    const patched = await runs.run({
      argv: node(`
        const fs = require("fs");
        fs.writeFileSync("/data/node_modules/ms/index.js", "module.exports = () => 'patched'");
        console.log(require("/data/node_modules/ms")(1000));
      `),
      files: cow(readOnly(deps), top),
    });
    const net = await runs.run({
      argv: node(
        "fetch('https://registry.npmjs.org/ms').then((r) => console.log('reached', r.status), (e) => console.log('blocked', e.message))",
      ),
    });
    await runs.close();
    return {
      install: { exitCode: install.exitCode, stdout: install.stdout, stderr: install.stderr },
      installMs,
      installed,
      first: first.stdout,
      firstErr: first.stderr,
      out,
      second: second.stdout,
      patched: patched.stdout,
      topPatched: await readText(top, "/node_modules/ms/index.js"),
      base: await readText(deps, "/node_modules/ms/index.js"),
      net: net.stdout,
    };
  },

  async __framework() {
    const { layer, steps } = await buildFrameworkLayer();
    if (!layer) return { steps, sites: [], layerDist: false };
    const runs = runPool();
    const sites = [];
    for (const files of [helloSite, { "src/about.md": "# About\n" }]) {
      const top = await filesOf(files);
      const r = await runs.run({
        argv: frameworkBuild("/data"),
        files: cow(readOnly(layer), top),
        cwd: "/data",
        timeoutMs: 300_000,
      });
      const page = Object.keys(files)[0]
        .replace(/^src\//, "")
        .replace(/\.md$/, ".html");
      sites.push({
        exitCode: r.exitCode,
        ms: r.ms,
        stdout: r.stdout.slice(-600),
        stderr: r.stderr.slice(-1500),
        html: (await top.exists(`/dist/${page}`)) ? await readText(top, `/dist/${page}`) : null,
        dist: await Array.fromAsync(top.list("/dist"), (e) => e.name).catch(() => []),
      });
    }
    await runs.close();
    return { steps, sites, layerDist: await layer.exists("/dist") };
  },

  async __preview() {
    const layer = frameworkLayer ?? (await buildFrameworkLayer()).layer;
    if (!layer) throw new Error("the Framework layer did not build");
    // a Lifo container without network in a worker of its own; the layers on this thread
    const worker = new Worker(new URL("./isolated-lifo-worker.ts", import.meta.url), {
      type: "module",
    });
    const engineChannel = new MessageChannel();
    const filesChannel = new MessageChannel();
    const mounts = new HostMounts();
    serveHostFiles(filesChannel.port1, mounts);
    worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
      engineChannel.port2,
      filesChannel.port2,
    ]);
    const top = await filesOf({ "src/index.md": "# Live\n\nversion one\n" });
    const c = createContainer(connectEngine(engineChannel.port1), {
      packages: [],
      env,
      mounts: [{ path: "/data", id: mounts.add(cow(readOnly(layer), top)) }],
      workdir: "/data",
    });
    const t0 = performance.now();
    try {
      await c.start({ entrypoint: frameworkPreview("/data", 3000) });
      await c.waitForPort?.(3000, 60_000);
      const startMs = Math.round(performance.now() - t0);
      const html = await (await c.getTcpPort(3000).fetch("http://container/")).text();
      const hash = html.match(/open\(\{hash: "([^"]+)"/)?.[1];
      // the page's live-reload client, with a WebSocket class into the container
      const WS = containerWebSocket(c, 3000);
      const ws = new WS("ws://container/_observablehq") as unknown as WebSocket;
      const messages: { type: string; html?: unknown }[] = [];
      ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", path: "/", hash }));
      const waitFor = async (type: string) => {
        for (let i = 0; i < 600; i++) {
          const m = messages.find((x) => x.type === type);
          if (m) return m;
          await new Promise((r) => setTimeout(r, 50));
        }
        return undefined;
      };
      const welcome = await waitFor("welcome");
      const t1 = performance.now();
      const edit = await c.exec([
        "node",
        "-e",
        "require('fs').writeFileSync('src/index.md', '# Live\\n\\nversion two\\n')",
      ]);
      const update = await waitFor("update");
      const updateMs = Math.round(performance.now() - t1);
      ws.close();
      return {
        startMs,
        pageHasVersionOne: html.includes("version one"),
        hash,
        welcome: !!welcome,
        edit: edit.exitCode,
        update: update ? JSON.stringify(update.html) : null,
        updateMs,
        topHasEdit: (await readText(top, "/src/index.md")).includes("version two"),
        types: messages.map((m) => m.type),
      };
    } finally {
      await c.destroy();
      worker.terminate();
    }
  },
});
