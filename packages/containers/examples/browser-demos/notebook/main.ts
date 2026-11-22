// An interactive Observable Framework notebook, served by `observable preview` in a Lifo container
// with no network, in this tab. The editor writes the notebook into the container; Framework's
// watcher sees it and pushes the change to the preview over its live-reload WebSocket.
//
// - The layer (Framework installed and adapted, its npm cache filled) is built once by a Lifo
//   container with egress, into a FilesApi on this thread (examples/observable-framework/recipe.ts).
// - The preview iframe loads /nb/…: webrun-http-browser's ServiceWorker routes those requests to
//   a handler on this page, which forwards them to container.getTcpPort(3000).fetch().
// - A ServiceWorker cannot answer WebSockets: each HTML page gets a script that gives the frame
//   this page's WebSocket class into the container (containerWebSocket).
import { readText, writeText } from "@statewalker/webrun-files";
import { cow, readOnly } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { type Container, createContainer } from "../../../src/container.ts";
import { HostMounts, serveHostFiles } from "../../../src/files/bridge.ts";
import { createIsolatedPool } from "../../../src/isolated-pool.ts";
import { connectEngine } from "../../../src/rpc.ts";
import { containerWebSocket } from "../../../src/websocket.ts";
import {
  frameworkBuildSteps,
  frameworkLayerFiles,
  frameworkPreview,
} from "../../observable-framework/recipe.ts";
import { BASE, startServiceWorker } from "../service-worker.ts";
import notebook from "./notebook.md?raw";

const KEY = "nb"; // the preview's first path segment, routed by the ServiceWorker to this page
// The preview is at <base>nb/ (the app's base path: its ServiceWorker's scope).
const PREVIEW = `${BASE}${KEY}`;
const PORT = 3000;
const env = { HOME: "/home/user", OBSERVABLE_TELEMETRY_DISABLE: "true" };
// what the notebook imports, for the build step to put into Framework's npm cache
const warmup =
  "```js\nPlot.plot({ marks: [Plot.line(d3.range(10))] })\n```\n\n```js\nview(Inputs.range([0, 1]))\n```\n";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const editor = $<HTMLTextAreaElement>("editor");
const preview = $<HTMLIFrameElement>("preview");
const logEl = $("log");
const log = (line: string) => {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};
const setStatus = (text: string, state = "busy") => {
  status.textContent = text;
  status.dataset.state = state;
  document.body.dataset.state = state;
};

/** 1. The layer: Framework installed by a container with egress, its npm cache filled. */
async function buildLayer() {
  const layer = new MemFilesApi();
  for (const [path, content] of Object.entries(frameworkLayerFiles("/data", { warmup })))
    await writeText(layer, `/${path}`, content);
  const build = createIsolatedPool({
    spawn: () => new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [], env, enableInternet: true },
    size: 1,
  });
  try {
    for (const argv of frameworkBuildSteps("/data")) {
      setStatus(`building the layer: ${argv.slice(0, 2).join(" ")}…`);
      const r = await build.run({ argv, files: layer, cwd: "/data", timeoutMs: 600_000 });
      log(`${argv.slice(0, 2).join(" ")}: exit ${r.exitCode} in ${r.ms} ms`);
      if (r.exitCode !== 0) throw new Error(r.stderr.slice(-500));
    }
  } finally {
    await build.close();
  }
  return layer;
}

/** 2. The notebook's container: no network, the layer read-only, the notebook in its own layer. */
async function startPreview(layer: MemFilesApi, site: MemFilesApi) {
  const worker = new Worker(new URL("./run-worker.ts", import.meta.url), { type: "module" });
  const engineChannel = new MessageChannel();
  const filesChannel = new MessageChannel();
  const mounts = new HostMounts();
  serveHostFiles(filesChannel.port1, mounts);
  worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
    engineChannel.port2,
    filesChannel.port2,
  ]);
  const container = createContainer(connectEngine(engineChannel.port1), {
    packages: [],
    env,
    mounts: [{ path: "/data", id: mounts.add(cow(readOnly(layer), site)) }],
    workdir: "/data",
  });
  container.setInactivityTimeout(24 * 60 * 60_000);
  setStatus("starting observable preview…");
  const t0 = performance.now();
  await container.start({ entrypoint: frameworkPreview("/data", PORT) });
  await container.waitForPort?.(PORT, 120_000);
  log(`preview serving in ${Math.round(performance.now() - t0)} ms`);
  return container;
}

/** 3. <base>nb/… → the container's port 3000; HTML pages get the WebSocket into the container. */
async function routePreview(adapter: SwHttpAdapter, container: Container) {
  const WS = containerWebSocket(container, PORT);
  // The frame's live-reload client says which page it shows by its path: drop <base>nb from it.
  class NotebookWebSocket extends (WS as unknown as typeof WebSocket) {
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === "string" && data.includes('"hello"')) {
        const message = JSON.parse(data);
        if (message.type === "hello") message.path = message.path.replace(PREVIEW, "") || "/";
        data = JSON.stringify(message);
      }
      super.send(data);
    }
  }
  Object.assign(window, { __notebookWebSocket: NotebookWebSocket });

  const inject =
    "<script>window.WebSocket = window.parent.__notebookWebSocket || window.WebSocket;</script>";
  await adapter.register(`${KEY}/`, async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.slice(PREVIEW.length) || "/";
    const res = await container.getTcpPort(PORT).fetch(`http://container${path}${url.search}`, {
      method: request.method,
      headers: request.headers,
    });
    const headers = new Headers(res.headers);
    // the frame is a document of this cross-origin-isolated page
    headers.set("cross-origin-embedder-policy", "credentialless");
    headers.set("cross-origin-resource-policy", "same-origin");
    if (!(headers.get("content-type") ?? "").includes("text/html"))
      return new Response(res.body, { status: res.status, headers });
    headers.delete("content-length");
    const html = (await res.text()).replace(/<head([^>]*)>/i, (m) => `${m}${inject}`);
    return new Response(html, { status: res.status, headers });
  });
}

/** Base64 of `bytes`, in chunks (a spread of a large array overflows the call stack). */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 4. Edits go into the container (Framework watches its files there). */
function wireEditor(container: Container) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = Promise.resolve();
  editor.disabled = false;
  editor.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const b64 = base64(new TextEncoder().encode(editor.value));
      writing = writing
        .then(async () => {
          const t0 = performance.now();
          const r = await container.exec([
            "node",
            "-e",
            `require('fs').writeFileSync('src/index.md', Buffer.from('${b64}', 'base64'))`,
          ]);
          log(`saved (exit ${r.exitCode}) in ${Math.round(performance.now() - t0)} ms`);
        })
        // a failed save is reported; the next one is still tried
        .catch((e) => log(`save failed: ${(e as Error).message ?? e}`));
    }, 400);
  });
}

async function main() {
  try {
    const t0 = performance.now();
    setStatus("starting the ServiceWorker…");
    const adapter = await startServiceWorker(KEY);
    const layer = await buildLayer();
    const site = new MemFilesApi();
    await writeText(site, "/src/index.md", notebook);
    editor.value = await readText(site, "/src/index.md");
    const container = await startPreview(layer, site);
    await routePreview(adapter, container);
    wireEditor(container);
    preview.src = `${PREVIEW}/`;
    await new Promise((r) => preview.addEventListener("load", r, { once: true }));
    setStatus(
      `ready in ${Math.round((performance.now() - t0) / 1000)} s · edit the notebook`,
      "ready",
    );
    Object.assign(window, { __notebook: { container, site } });
  } catch (e) {
    setStatus(`failed: ${(e as Error).message}`, "error");
    log(String((e as Error).stack ?? e));
  }
}

void main();
