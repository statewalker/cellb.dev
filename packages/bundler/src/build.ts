/**
 * `buildProject`: a wrangler project's sources (a FilesApi) bundled by webrun-bundler into one
 * Worker module plus its assets: a folder that Wrangler (`no_bundle`), celld and cellb run as is.
 *
 * The same function runs in every tier: inside the bundler's Durable Object (esbuild-wasm), in
 * the Node runner (native esbuild or esbuild-wasm, for builds too large for an isolate), and in a
 * browser worker. Only `esbuild` and `packages` change.
 */

import { listFiles, parseJsonc } from "@statewalker/cellb-platform-core/util";
import {
  bundle,
  chainPackages,
  type Esbuild,
  nodeModulesPackages,
  npmPackages,
  type PackageStore,
} from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { readFile, tryReadText } from "@statewalker/webrun-files";
import { npmRegistrySource } from "@statewalker/webrun-modules";
import { COMPAT_ENTRY, compatEntrySource, overlay } from "./compat.js";

/** Part of every build id: a change to the build changes the ids, so no stale build is served. */
export const BUILDER_VERSION = "webrun-platform-builder/3";

export interface BuildSpec {
  /** The entry module (default: wrangler config's `main`). */
  entry?: string;
  /**
   * `worker`: a Worker for workerd, celld and cellb; `browser`: an ES module for a page; `astro`:
   * an Astro project built from its sources first (src/astro). Default: `astro` when the project
   * has an `astro.config.*`, else `worker`.
   */
  kind?: "worker" | "browser" | "astro";
  /** Options of an Astro build (`kind: "astro"`). */
  astro?: import("@statewalker/cellb-astro-builder/project").AstroSpec;
  minify?: boolean;
  /** Write `worker.js.map` (default true). */
  sourcemap?: boolean;
  /** Wrap the Worker's entry with the host compatibility layer (./compat.ts). Default true. */
  hostCompat?: boolean;
  /** Lower `await` to generators (AsyncLocalStorage polyfills follow it). Default false. */
  lowerAwait?: boolean;
  conditions?: string[];
  external?: string[];
  define?: Record<string, string>;
}

export interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  assets?: { directory?: string; binding?: string; [k: string]: unknown };
  d1_databases?: { binding: string; migrations_dir?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface BuildOutput {
  /** The built project's configuration (`main: "worker.js"`, `no_bundle: true`). */
  config: WranglerConfig;
  /** Output files by path: `/wrangler.json`, `/worker.js`, `/worker.js.map`, `/assets/…`, `/migrations/…`. */
  files: Map<string, Uint8Array>;
  stats: {
    inputFiles: number;
    inputBytes: number;
    packages: string[];
    workerBytes: number;
    ms: number;
    warnings: number;
  };
}

const NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

/**
 * `node:module` with a `createRequire` that works on every host: the runtime's where it has one
 * (workerd, cellb), else a `require` that serves the common Node built-ins (imported statically) and throws
 * at the call site for anything else, as Node does for a missing module. celld 0.6.3 throws "not implemented" from `createRequire` itself, which libraries call
 * at module initialization (EmDash does) and only use behind try/catch. The shim imports the
 * runtime's module as bare `module`, which `modules` does not intercept.
 */
const SHIM_BUILTINS = [
  "assert",
  "buffer",
  "crypto",
  "events",
  "path",
  "stream",
  "string_decoder",
  "url",
  "util",
];
const NODE_MODULE_SHIM = `import * as real from "module";
${SHIM_BUILTINS.map((n, i) => `import * as b${i} from "node:${n}";`).join("\n")}
const builtins = { ${SHIM_BUILTINS.map((n, i) => `${JSON.stringify(n)}: b${i}`).join(", ")} };
export * from "module";
export function createRequire(url) {
  try {
    return real.createRequire(url);
  } catch {
    const require = (id) => {
      const m = builtins[id.replace(/^node:/, "")];
      if (m) return m.default ?? m;
      const e = new Error("Cannot find module '" + id + "' (require is not available on this host)");
      e.code = "MODULE_NOT_FOUND";
      throw e;
    };
    require.resolve = (id) => {
      if (builtins[id.replace(/^node:/, "")]) return id;
      return require(id);
    };
    require.cache = {};
    return require;
  }
}
export default { ...(real.default ?? real), createRequire };
`;

/** Reads `wrangler.jsonc` / `wrangler.json` at the project root (`{}` when there is none). */
export async function readWranglerConfig(files: FilesApi, root = "/"): Promise<WranglerConfig> {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const t = await tryReadText(files, `${root.replace(/\/$/, "")}/${name}`);
    if (t !== undefined) return parseJsonc(t) as WranglerConfig;
  }
  return {};
}

/** Packages from the project's node_modules, else from the registry (through `fetch`). */
export function defaultPackages(fetchImpl?: typeof fetch): PackageStore {
  return chainPackages(
    nodeModulesPackages(),
    npmPackages({ source: npmRegistrySource({ fetch: fetchImpl }) }),
  );
}

export async function buildProject(opts: {
  files: FilesApi;
  esbuild: Esbuild;
  packages?: PackageStore;
  spec?: BuildSpec;
  log?: (msg: string) => void;
}): Promise<BuildOutput> {
  const started = Date.now();
  const { files } = opts;
  const spec = opts.spec ?? {};
  const log = opts.log ?? (() => {});
  const config = await readWranglerConfig(files);
  const entry = spec.entry ?? config.main;
  if (!entry) throw new Error("nothing to build: no `entry` and no wrangler `main`");
  const flags = config.compatibility_flags ?? [];
  const nodeCompat = flags.some((f) => f.startsWith("nodejs_compat"));
  const kind = spec.kind ?? "worker";

  const inputPaths = (await listFiles(files)).filter((p) => !p.startsWith("/node_modules/"));
  let inputBytes = 0;
  for (const p of inputPaths) {
    const st = await files.stats(p);
    if (st?.kind === "file") inputBytes += st.size;
  }

  const packagesSeen = new Set<string>();
  const inner = opts.packages ?? defaultPackages();
  const packages: PackageStore = {
    async get(name, importer) {
      const m = await inner.get(name, importer);
      if (m) packagesSeen.add(m.prefix.replace(/^npm:/, ""));
      return m;
    },
  };

  log(
    `bundling ${entry} (${kind}, ${inputPaths.length} files, ${(inputBytes / 1e6).toFixed(1)} MB)`,
  );
  const worker = kind === "worker";
  const external = [
    ...(worker ? ["cloudflare:*", "node:*"] : []),
    ...(worker && nodeCompat ? NODE_BUILTINS.flatMap((n) => [n, `${n}/*`]) : []),
    ...(spec.external ?? []),
  ];
  const outfile = worker ? "worker.js" : "bundle.js";
  const d1 = (config.d1_databases ?? []).map((d) => d.binding);
  const compat = worker && spec.hostCompat !== false;
  const result = await bundle({
    esbuild: opts.esbuild,
    files: compat ? overlay(files, new Map([[COMPAT_ENTRY, compatEntrySource(entry, d1)]])) : files,
    entry: compat ? COMPAT_ENTRY : `/${entry.replace(/^\.?\/+/, "")}`,
    packages,
    external,
    modules: (specifier) =>
      worker && nodeCompat && specifier === "node:module" ? NODE_MODULE_SHIM : undefined,
    conditions: spec.conditions ?? (worker ? ["workerd", "worker", "browser"] : ["browser"]),
    platform: "browser",
    lowerAwait: spec.lowerAwait ?? false,
    minify: spec.minify ?? false,
    define: spec.define,
    outfile,
    sourcemap: spec.sourcemap === false ? false : "external",
    // Function names are observable (stack traces, `name` checks in libraries): keep them.
    esbuildOptions: { keepNames: true },
  });
  const enc = new TextEncoder();
  const out = new Map<string, Uint8Array>();
  const code = enc.encode(result.code);
  out.set(`/${outfile}`, code);
  if (spec.sourcemap !== false) out.set(`/${outfile}.map`, enc.encode(JSON.stringify(result.map)));

  const built: WranglerConfig = { ...config, main: outfile, no_bundle: true };
  delete built.$schema;
  delete built.build;
  delete built.alias;
  delete built.rules;
  delete built.find_additional_modules;
  delete built.base_dir;

  // Bindings that `wrangler dev` provisions on its own but a deployment names: a KV namespace
  // without an `id` (Astro's adapter adds `SESSION` so) gets a stable one, which celld requires.
  const kv = config.kv_namespaces as { binding: string; id?: string }[] | undefined;
  if (kv?.length)
    built.kv_namespaces = kv.map((n) =>
      n.id ? n : { ...n, id: `${config.name ?? "worker"}-${n.binding}`.toLowerCase() },
    );

  // Static assets travel with the build.
  if (config.assets?.directory) {
    const dir = `/${config.assets.directory.replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;
    for (const p of await listFiles(files, dir))
      out.set(`/assets${p.slice(dir.length)}`, await readFile(files, p));
    built.assets = { ...config.assets, directory: "assets" };
  }
  // D1 migrations too (the folder each database names, `migrations` by default).
  for (const db of config.d1_databases ?? []) {
    const dir = `/${(db.migrations_dir ?? "migrations").replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;
    for (const p of await listFiles(files, dir)) out.set(p, await readFile(files, p));
  }
  if (worker) out.set("/wrangler.json", enc.encode(`${JSON.stringify(built, null, 2)}\n`));

  const ms = Date.now() - started;
  log(
    `built ${outfile}: ${(code.length / 1e6).toFixed(2)} MB, ${packagesSeen.size} packages, ${ms} ms`,
  );
  return {
    config: built,
    files: out,
    stats: {
      inputFiles: inputPaths.length,
      inputBytes,
      packages: [...packagesSeen].sort(),
      workerBytes: code.length,
      ms,
      warnings: result.warnings.length,
    },
  };
}

/** A Worker Loader payload (`env.LOADER.get(id, () => payload)`): the build as one module. */
export function loaderPayload(output: BuildOutput): Record<string, unknown> {
  const code = new TextDecoder().decode(output.files.get("/worker.js"));
  return {
    compatibilityDate: output.config.compatibility_date ?? "2026-02-24",
    compatibilityFlags: output.config.compatibility_flags ?? [],
    mainModule: "worker.js",
    modules: { "worker.js": code },
  };
}
