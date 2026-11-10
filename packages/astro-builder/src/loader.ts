/**
 * Where an Astro build runs inside the bundler's object:
 *
 * - in this realm, when it can evaluate code (cellb, browsers): `buildAstroProject` evaluates the
 *   bundled config with a data: URL import;
 * - else in a Worker Loader isolate (workerd, celld): the config is bundled here and loaded,
 *   with the builder (./loaded-builder.ts) and the WebAssembly it needs, as the modules of a
 *   Worker; the build runs there and returns its output.
 */

import builderSource from "virtual:astro-builder-source";
import { sha256Hex, unzip, zip } from "@statewalker/cellb-platform-core/util";
import type { Esbuild, PackageStore } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { readFile } from "@statewalker/webrun-files";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import { ASTRO_COMPILER_BINDING } from "./compiler.js";
import { bundleAstroConfig } from "./integrations.js";
import { type AstroSpec, appView, ROOT } from "./project.js";

let evaluates: Promise<boolean> | undefined;

/** Whether this realm can evaluate a module from a string (a data: URL import). */
export function canEvaluate(): Promise<boolean> {
  evaluates ??= (async () => {
    try {
      const n = String(Math.floor(Math.random() * 1000));
      const m = await import(/* @vite-ignore */ `data:text/javascript,export default ${n}`);
      return String(m.default) === n;
    } catch {
      return false;
    }
  })();
  return evaluates;
}

export interface WorkerLoader {
  get(
    id: string,
    code: () => unknown,
  ): { getEntrypoint(): { fetch(input: string, init?: RequestInit): Promise<Response> } };
}

const wasmBytes = new Map<string, Promise<ArrayBuffer>>();

/** A file of an npm package, as bytes, through the package store. */
function packageFile(fetchImpl: typeof fetch, pkg: string, version: string, path: string) {
  const key = `${pkg}@${version}${path}`;
  let p = wasmBytes.get(key);
  if (!p) {
    p = (async () => {
      const loaded = await npmRegistrySource({ fetch: fetchImpl }).load({ pkg, version });
      const bytes = await readFile(loaded.files, path);
      return bytes.slice().buffer as ArrayBuffer;
    })();
    wasmBytes.set(key, p);
  }
  return p;
}

/** Builds the Astro project in a Worker Loader isolate; returns the output files and the log. */
export async function astroInLoader(opts: {
  loader: WorkerLoader;
  files: FilesApi;
  esbuild: Esbuild & { version: string };
  packages: PackageStore;
  /** Fetch for the npm registry (the package store), for the WebAssembly the isolate needs. */
  registryFetch: typeof fetch;
  spec?: AstroSpec;
  log?: (m: string) => void;
}): Promise<{ files: Map<string, Uint8Array>; routes: number; ms: number }> {
  const spec = opts.spec ?? {};
  const t = Date.now();
  const config = await bundleAstroConfig({
    esbuild: opts.esbuild,
    files: appView(opts.files),
    root: ROOT,
    packages: opts.packages,
    metaUrl: spec.metaUrl,
    log: opts.log,
  });
  const [esbuildWasm, astroWasm] = await Promise.all([
    packageFile(opts.registryFetch, "esbuild-wasm", opts.esbuild.version, "/esbuild.wasm"),
    packageFile(
      opts.registryFetch,
      ASTRO_COMPILER_BINDING.name,
      ASTRO_COMPILER_BINDING.version,
      "/astro.wasm32-wasi.wasm",
    ),
  ]);
  const id = `astro-builder:${(await sha256Hex(`${builderSource.length}\n${config}`)).slice(0, 24)}`;
  opts.log?.(`running the Astro build in a Worker Loader isolate (${id})`);
  const worker = opts.loader.get(id, () => ({
    compatibilityDate: "2026-02-24",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "builder.js",
    modules: {
      "builder.js": builderSource,
      "config.js": config,
      "esbuild.wasm": { wasm: esbuildWasm },
      "astro.wasm": { wasm: astroWasm },
    },
  }));
  const input: [string, Uint8Array][] = [];
  for await (const e of opts.files.list("/", { recursive: true }))
    if (e.kind === "file") input.push([e.path, await readFile(opts.files, e.path)]);
  const res = await worker.getEntrypoint().fetch("http://astro-builder/", {
    method: "POST",
    headers: { "x-astro-spec": JSON.stringify(spec) },
    body: zip(input) as BodyInit,
  });
  if (!res.ok) throw new Error(`the Astro build failed in its isolate: ${await res.text()}`);
  const files = await unzip(new Uint8Array(await res.arrayBuffer()));
  const meta = JSON.parse(
    new TextDecoder().decode(files.get("/.astro-log.json") ?? new Uint8Array()) || "{}",
  ) as {
    log?: string[];
    routes?: number;
  };
  files.delete("/.astro-log.json");
  for (const line of meta.log ?? []) opts.log?.(`  ${line}`);
  return { files, routes: meta.routes ?? 0, ms: Date.now() - t };
}
