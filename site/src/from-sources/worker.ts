/// <reference lib="webworker" />
// Builds a project from its sources and runs it, all in this Dedicated Worker:
//   1. the sources go into an in-memory FilesApi;
//   2. loadProject compiles them with bundleCompiler: webrun-bundler on esbuild-wasm, fetching npm
//      packages from the registry at the versions package.json asks for, and taking
//      `cloudflare:workers` and the Workers globals from CellB;
//   3. CellB's browser host imports the bundle and serves requests, with SQLite WASM on OPFS.
import { parseJsonc, type WranglerConfig } from "@statewalker/cellb";
import { type LoadedProject, loadProject } from "@statewalker/cellb/browser";
import { bundleCompiler } from "@statewalker/cellb/bundle";
import { npmPackages } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";

export type ToWorker =
  | { type: "build"; files: Record<string, string> }
  | { type: "fetch"; path: string };
export type FromWorker =
  | { type: "log"; text: string }
  | { type: "built" }
  | { type: "response"; status: number; contentType: string | null; body: string }
  | { type: "error"; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker) => scope.postMessage(m);
const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`;

// OPFS entries of this page: a pool per worker, removed when the next worker starts.
const PREFIX = "cellb-sources-";
const run = `${PREFIX}${Date.now().toString(36)}`;
let host: LoadedProject | undefined;
let ready: Promise<unknown> | undefined;
// One package cache for the worker's life: a second build fetches nothing.
const compile = bundleCompiler({ esbuild, packages: npmPackages() });

async function removeLeftovers() {
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
    if (name.replace(/^\./, "").startsWith(PREFIX) && !name.includes(run))
      await root.removeEntry(name, { recursive: true }).catch(() => {}); // another tab's
}

async function build(sources: Record<string, string>) {
  let t0 = performance.now();
  ready ??= Promise.all([esbuild.initialize({ wasmURL, worker: false }), removeLeftovers()]);
  await ready;
  post({ type: "log", text: `esbuild-wasm ${esbuild.version} ready (${ms(t0)})` });

  const files = new MemFilesApi();
  for (const [path, text] of Object.entries(sources))
    await files.write(`/${path}`, [new TextEncoder().encode(text)]);
  const config = parseJsonc(sources["wrangler.jsonc"]) as WranglerConfig;

  t0 = performance.now();
  await host?.close();
  host = await loadProject(files, { data: run, compile });
  post({
    type: "log",
    text: `bundled ${config.main} and its packages, and CellB started the project (${ms(t0)})`,
  });
  post({ type: "built" });
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  try {
    if (e.data.type === "build") return await build(e.data.files);
    if (!host) throw new Error("build the project first");
    const res = await host.fetch(new Request(`http://localhost${e.data.path}`));
    post({
      type: "response",
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: await res.text(),
    });
  } catch (err) {
    post({ type: "error", error: String((err as Error)?.message ?? err) });
  }
};
