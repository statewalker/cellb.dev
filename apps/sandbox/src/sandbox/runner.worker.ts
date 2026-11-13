/// <reference lib="webworker" />
// The runner: one Dedicated Worker that takes a folder's files and runs the app they make.
//
//   server  wrangler.jsonc + main → loadProject(files, { compile: bundleCompiler }) — bundled by
//           webrun-bundler on esbuild-wasm (npm packages from the registry), run by CellB with
//           its Durable Objects on SQLite WASM in OPFS
//   client  index.html + TS/TSX/JS/JSX/CSS → compiled module by module by webrun-modules
//   both    one site (createAppSite), hosted by the page's ServiceWorker (siteHostOverPort ↔
//           hostSitesForWorker), so the preview iframe and any tab of this origin can open it

import { linkOverPort } from "@statewalker/cellb";
import { type LoadedProject, loadProject } from "@statewalker/cellb/browser";
import { bundleCompiler } from "@statewalker/cellb/bundle";
import { type HostedProjectSite, siteHostOverPort } from "@statewalker/cellb/site";
import { astroCompilerFromRegistry } from "@statewalker/cellb-astro-builder/compiler";
import { buildAstroProject } from "@statewalker/cellb-astro-builder/project";
import { buildProject } from "@statewalker/cellb-bundler";
import { buildAny } from "@statewalker/cellb-bundler/any";
import { projectPeers } from "@statewalker/cellb-platform-core/peers";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";
import { TokenCap } from "../../studio/src/capfs/token-cap";
import { createAppSite } from "./app-site";
import { assembleDeploy } from "./deploy";
import { exportClient } from "./export";
import { createNotebookSite, exportNotebooks, notebookFilesOf } from "./notebooks";
import { clientFilesOf, describeProject, SKIPPED_DIRS } from "./project";
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
const notebookCache = new MemFilesApi();
const compile = bundleCompiler({ esbuild, packages });
const hostSite = siteHostOverPort(scope);
// Astro's compiler (compiler-rs as wasm32-wasi, from the npm registry): loaded on the first Astro
// build. It needs a shared WebAssembly memory, so the page is cross-origin isolated (its
// ServiceWorker adds COOP/COEP, integrations/sw-worker.mjs).
let astroCompiler: ReturnType<typeof astroCompilerFromRegistry> | undefined;
const compilerOfAstro = () => {
  if (!globalThis.crossOriginIsolated)
    throw new Error(
      "Astro's compiler needs a cross-origin isolated page: reload the sandbox (its ServiceWorker isolates it)",
    );
  astroCompiler ??= astroCompilerFromRegistry();
  astroCompiler.catch(() => {
    astroCompiler = undefined;
  });
  return astroCompiler;
};

/** An Astro site's sources → what Astro's Cloudflare build writes (wrangler.json, server/, client/). */
async function buildAstro(entries: [string, Uint8Array][]) {
  const src = new MemFilesApi();
  for (const [path, bytes] of entries) await src.write(path, [bytes]);
  const out = await buildAstroProject({
    files: src,
    esbuild,
    transform: await compilerOfAstro(),
    packages: await projectPeers(packages, src),
    log: (m) => log(`astro: ${m}`),
  });
  const built = new MemFilesApi();
  for (const [p, b] of out.files) await built.write(p, [b]);
  return { files: built, routes: out.routes, ms: out.ms };
}

/**
 * Astro's pages name their bundles from the site's root (/_astro/…); the preview serves the site
 * under a path of its own. The page's and the modules' references are moved under it.
 */
function underSitePath(
  server: LoadedProject,
  sitePath: () => string,
): Pick<LoadedProject, "fetch"> {
  return {
    async fetch(request: Request) {
      const res = await server.fetch(request);
      const type = res.headers.get("content-type") ?? "";
      const base = sitePath();
      if (base === "/" || !/text\/html|javascript|text\/css/.test(type)) return res;
      const text = (await res.text()).replace(/(["'(=\s])\/_astro\//g, `$1${base}_astro/`);
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      return new Response(text, { status: res.status, statusText: res.statusText, headers });
    },
  };
}

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
  if (!layout.wranglerPath && !layout.clientRoot && !layout.notebooks && !layout.astro)
    throw new Error(layout.problems.join("; "));

  let project: LoadedProject | undefined;
  let sitePath = "/";
  let server: Pick<LoadedProject, "fetch"> | undefined;
  if (layout.astro) {
    let t = performance.now();
    esbuildReady ??= esbuild.initialize({ wasmURL, worker: false });
    await esbuildReady;
    log(`an Astro site (${layout.astro.slice(1)}): building it from its sources`);
    const astro = await buildAstro(entries);
    log(`astro: ${astro.routes} routes built (${since(t)})`);
    t = performance.now();
    project = await openProject(astro.files, layout.name);
    current.project = project;
    server = underSitePath(project, () => sitePath);
    log(`server: Astro's Worker started on CellB (${since(t)})`);
  } else if (layout.wranglerPath && layout.config?.main) {
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
    server = project;
    const unsupported = project.unsupported?.length
      ? ` (not supported: ${project.unsupported.join(", ")})`
      : "";
    log(
      `server: bundled ${layout.config.main} and started it on CellB (${since(t)})${unsupported}`,
    );
  } else log("no server part: the client runs alone");

  const notebookFiles = notebookFilesOf(all);
  const site = await createAppSite({
    client: layout.clientRoot ? clientFilesOf(all, layout.clientRoot) : undefined,
    server,
    log,
    moduleCache,
    notebooks: notebookFiles
      ? createNotebookSite({
          files: notebookFiles,
          sitePath: () => sitePath,
          cache: notebookCache,
          log,
        })
      : undefined,
  });
  const hosted = await hostSite(site);
  sitePath = new URL(hosted.baseUrl).pathname;
  if (notebookFiles) log("notebooks: served at notebooks/, built on the first visit");
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

// The project's files come through a capability: the studio checks the token on every call,
// and this worker never holds the folder (or the memory, OPFS, S3… behind it).
let latestRun = 0;
let studioLink: Promise<{ send: (r: Request) => Promise<Response> }> | undefined;
async function snapshot(workspace: string, token: string): Promise<[string, Uint8Array][]> {
  if (!studioLink) throw new Error("the runner has no link to the studio");
  const { send } = await studioLink;
  const tree = await new TokenCap(send, workspace, token).readTree("/", {
    contents: true,
    skip: [...SKIPPED_DIRS],
  });
  return tree.filter((e) => !e.dir && e.data).map((e) => [e.path, e.data as Uint8Array]);
}

/**
 * The deployable folder: the server bundled by buildProject (a no_bundle Worker), the client
 * exported from a site made of the same sources (so no running app is needed).
 */
async function build(id: number, entries: [string, Uint8Array][], folderName: string) {
  const t0 = performance.now();
  const all = new Map(entries);
  const layout = describeProject(all, folderName);
  if (!layout.wranglerPath && !layout.clientRoot && !layout.notebooks && !layout.astro)
    throw new Error(layout.problems.join("; "));
  esbuildReady ??= esbuild.initialize({ wasmURL, worker: false });
  await esbuildReady;
  let server: { config: Record<string, unknown>; files: Map<string, Uint8Array> } | undefined;
  if (layout.astro) {
    // Astro's Cloudflare output, built from the sources, then bundled like any Worker project.
    const files = new MemFilesApi();
    for (const [path, bytes] of entries) await files.write(path, [bytes]);
    const out = await buildAny({
      files,
      esbuild,
      packages,
      astroCompiler: compilerOfAstro,
      log: (m) => log(`build: ${m}`),
    });
    server = { config: out.config as Record<string, unknown>, files: out.files };
  } else if (layout.wranglerPath && layout.config?.main) {
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
  // The notebooks, with their modules materialized: the deployment serves them as assets.
  const notebookFiles = notebookFilesOf(all);
  if (notebookFiles) {
    const nb = await exportNotebooks(notebookFiles, notebookCache, log);
    client = new Map([...(client ?? []), ...nb]);
  }
  const out = assembleDeploy({ name: layout.name, server, client });
  const summary = `deployable build of ${layout.name}: ${out.size} files (${since(t0)})`;
  log(summary);
  post({ type: "built", id, files: [...out], summary });
}

scope.addEventListener("message", (e: MessageEvent<ToRunner>) => {
  const msg = e.data as ToRunner | undefined;
  if (!msg || typeof msg !== "object" || !("type" in msg)) return; // site-host traffic
  if (msg.type === "studio-port") {
    studioLink = linkOverPort(msg.port);
  } else if (msg.type === "run") {
    // A run waiting in the queue is replaced by a newer one: only the latest files run.
    const mine = ++latestRun;
    queue = queue
      .then(async () => {
        if (mine !== latestRun) return;
        await run(await snapshot(msg.workspace, msg.token), msg.folderName);
      })
      .catch(async (err) => {
        await stop();
        const text = String((err as Error)?.message ?? err);
        log(text, "error");
        post({ type: "failed", error: text });
      });
  } else if (msg.type === "build") {
    queue = queue
      .then(async () => build(msg.id, await snapshot(msg.workspace, msg.token), msg.folderName))
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
