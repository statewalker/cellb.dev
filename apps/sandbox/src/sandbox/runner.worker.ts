/// <reference lib="webworker" />
// The runner: one Dedicated Worker that takes a folder's files and runs the app they make.
//
//   server  wrangler.jsonc + main → loadProject(files, { compile: bundleCompiler }) — bundled by
//           webrun-bundler on esbuild-wasm (npm packages from the registry), run by CellB with
//           its Durable Objects on SQLite WASM in OPFS
//   client  index.html + TS/TSX/JS/JSX/CSS → compiled module by module by webrun-modules
//   both    one site (createAppSite), hosted by the page's ServiceWorker (siteHostOverPort ↔
//           hostSitesForWorker), so the preview iframe and any tab of this origin can open it

import { type LoadedProject, loadProject } from "@statewalker/cellb/browser";
import { bundleCompiler } from "@statewalker/cellb/bundle";
import { type HostedProjectSite, siteHostOverPort } from "@statewalker/cellb/site";
import { buildProject } from "@statewalker/cellb-bundler";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import { createAppSite } from "./app-site";
import { assembleDeploy } from "./deploy";
import { exportClient } from "./export";
import { clientFilesOf, describeProject } from "./project";
import type { FromRunner, ToRunner } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromRunner) => scope.postMessage(m);
const log = (text: string, level: "info" | "error" = "info") => post({ type: "log", text, level });
const since = (t0: number) => `${Math.round(performance.now() - t0)} ms`;

// The app's server code runs in this worker: its console goes to the log too (people and agents
// read it there), and still to the worker's own console.
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const text = args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? (a.stack ?? a.message)
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })(),
      )
      .join(" ");
    post({
      type: "log",
      text: `console.${level}: ${text}`,
      level: level === "error" || level === "warn" ? "error" : "info",
    });
  };
}

// OPFS pools of this sandbox are named after the project, so its Durable Objects keep their data
// from one run to the next. A pool another tab holds cannot be opened: then this run gets its own.
const POOL_PREFIX = "cellb-sandbox-";

let esbuildReady: Promise<void> | undefined;
// One package store and one module cache for the worker's life: a rerun downloads nothing twice.
const packages = npmPackages();
const moduleCache = new MemFilesApi();
const compile = bundleCompiler({ esbuild, packages });
const hostSite = siteHostOverPort(scope);

let current: {
  project?: LoadedProject;
  site?: HostedProjectSite;
  handler?: (request: Request) => Promise<Response>;
} = {};
let queue = Promise.resolve();

async function stop() {
  const { project, site } = current;
  current = {};
  await site?.stop().catch(() => {});
  await project?.close().catch(() => {});
}

async function openProject(files: MemFilesApi, name: string) {
  const data = `${POOL_PREFIX}${name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  try {
    return await loadProject(files, { data, compile });
  } catch (err) {
    if (!/lock|busy|access handle|NoModificationAllowed/i.test(String(err))) throw err;
    log(`the data of "${name}" is open in another tab: this run starts with empty storage`);
    return loadProject(files, { data: `${data}-${Date.now().toString(36)}`, compile });
  }
}

async function run(entries: [string, Uint8Array][], folderName: string) {
  const t0 = performance.now();
  post({ type: "phase", phase: "building" });
  await stop();
  const all = new Map(entries);
  const layout = describeProject(all, folderName);
  for (const p of layout.problems) log(p, "error");
  if (!layout.wranglerPath && !layout.clientRoot) throw new Error(layout.problems.join("; "));

  let project: LoadedProject | undefined;
  if (layout.wranglerPath && layout.config?.main) {
    let t = performance.now();
    esbuildReady ??= esbuild.initialize({ wasmURL, worker: false });
    await esbuildReady;
    log(`esbuild-wasm ${esbuild.version} ready (${since(t)})`);
    t = performance.now();
    const files = new MemFilesApi();
    for (const [path, bytes] of entries)
      if (
        !layout.clientRoot ||
        layout.clientRoot === "/" ||
        !path.startsWith(`${layout.clientRoot}/`)
      )
        await files.write(path, [bytes]);
    project = await openProject(files, layout.name);
    current.project = project;
    const unsupported = project.unsupported?.length
      ? ` (not supported: ${project.unsupported.join(", ")})`
      : "";
    log(
      `server: bundled ${layout.config.main} and started it on CellB (${since(t)})${unsupported}`,
    );
  } else log("no server part: the client runs alone");

  const site = await createAppSite({
    client: layout.clientRoot ? clientFilesOf(all, layout.clientRoot) : undefined,
    server: project,
    log,
    moduleCache,
  });
  const hosted = await hostSite(site);
  current.site = hosted;
  current.handler = site;
  if (layout.clientRoot)
    log(
      `client: ${layout.clientRoot === "/" ? "the folder's root" : `${layout.clientRoot.slice(1)}/`} served, its modules compiled on request`,
    );
  log(`running at ${hosted.baseUrl} (${since(t0)})`);
  post({
    type: "running",
    baseUrl: hosted.baseUrl,
    name: layout.name,
    server: !!project,
    client: !!layout.clientRoot,
  });
}

// The studio: the agents' side (studio/: Workspace and Agent cells, Flue agents on a capability
// file system), a second CellB project in this worker, loaded the first time the page asks.
// Its Worker code runs in this realm, so `globalThis.cellbStudioHost` is how its agents reach
// the page: run the app, read the log, call the app (the page applies the agents' writes to its
// folder first).
let studio: Promise<LoadedProject> | undefined;
function openStudio(url: string) {
  // Its cells keep their state (conversations, sessions) in OPFS; a pool another tab holds
  // cannot be opened, so that tab's studio gets one of its own.
  const open = (data: string) => loadProject(new URL(url), { data });
  studio ??= open("cellb-sandbox-studio")
    .catch((err) => {
      if (!/lock|busy|access handle|NoModificationAllowed/i.test(String(err))) throw err;
      return open(`cellb-sandbox-studio-${Date.now().toString(36)}`);
    })
    .catch((err) => {
      studio = undefined;
      throw err;
    });
  return studio;
}
let hostCallId = 0;
const hostCalls = new Map<
  number,
  (out: { ok: true; result: unknown } | { ok: false; error: string }) => void
>();
(globalThis as { cellbStudioHost?: unknown }).cellbStudioHost = {
  call(tool: "run_app" | "read_logs" | "http_request", args: Record<string, unknown>) {
    const id = ++hostCallId;
    return new Promise((resolve) => {
      hostCalls.set(id, resolve);
      post({ type: "host-call", id, tool, args });
    });
  },
};

/**
 * The deployable folder: the server bundled by buildProject (a no_bundle Worker), the client
 * exported from a site made of the same sources (so no running app is needed).
 */
async function build(id: number, entries: [string, Uint8Array][], folderName: string) {
  const t0 = performance.now();
  const all = new Map(entries);
  const layout = describeProject(all, folderName);
  if (!layout.wranglerPath && !layout.clientRoot) throw new Error(layout.problems.join("; "));
  esbuildReady ??= esbuild.initialize({ wasmURL, worker: false });
  await esbuildReady;
  let server: { config: Record<string, unknown>; files: Map<string, Uint8Array> } | undefined;
  if (layout.wranglerPath && layout.config?.main) {
    const files = new MemFilesApi();
    for (const [path, bytes] of entries)
      if (
        !layout.clientRoot ||
        layout.clientRoot === "/" ||
        !path.startsWith(`${layout.clientRoot}/`)
      )
        await files.write(path, [bytes]);
    const out = await buildProject({ files, esbuild, packages, log: (m) => log(`build: ${m}`) });
    server = { config: out.config as Record<string, unknown>, files: out.files };
  }
  let client: Map<string, Uint8Array> | undefined;
  if (layout.clientRoot) {
    const clientFiles = clientFilesOf(all, layout.clientRoot);
    const site = await createAppSite({ client: clientFiles, log, moduleCache });
    client = await exportClient(site, clientFiles, (m) => log(`build: ${m}`));
  }
  const out = assembleDeploy({ name: layout.name, server, client });
  const summary = `deployable build of ${layout.name}: ${out.size} files (${since(t0)})`;
  log(summary);
  post({ type: "built", id, files: [...out], summary });
}

scope.addEventListener("message", (e: MessageEvent<ToRunner>) => {
  const msg = e.data as ToRunner | undefined;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return; // site-host traffic
  if (msg.type === "run") {
    queue = queue
      .then(() => run(msg.files, msg.folderName))
      .catch(async (err) => {
        await stop();
        const text = String((err as Error)?.message ?? err);
        log(text, "error");
        post({ type: "failed", error: text });
      });
  } else if (msg.type === "studio") {
    // Not queued behind runs: an agent's run_app waits on a run while its request is open.
    void (async () => {
      try {
        const project = await openStudio(msg.studioUrl);
        const res = await project.fetch(
          new Request(`http://studio${msg.path}`, {
            method: msg.method,
            headers: msg.headers,
            body: msg.body,
          }),
        );
        post({ type: "studio-reply", id: msg.id, status: res.status, body: await res.text() });
      } catch (err) {
        post({
          type: "studio-reply",
          id: msg.id,
          status: 500,
          body: JSON.stringify({ error: String((err as Error)?.message ?? err) }),
        });
      }
    })();
  } else if (msg.type === "host-reply") {
    hostCalls.get(msg.id)?.(msg.out);
    hostCalls.delete(msg.id);
  } else if (msg.type === "build") {
    queue = queue
      .then(() => build(msg.id, msg.files, msg.folderName))
      .catch((err) => {
        const text = String((err as Error)?.message ?? err);
        log(`build: ${text}`, "error");
        post({ type: "build-failed", id: msg.id, error: text });
      });
  } else if (msg.type === "stop") {
    queue = queue.then(stop).then(() => post({ type: "phase", phase: "stopped" }));
  }
});

post({ type: "phase", phase: "idle" });
