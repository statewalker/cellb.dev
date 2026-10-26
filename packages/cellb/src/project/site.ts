import { type FilesApi, readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import {
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { NODE_POLYFILL_FILES, NODE_POLYFILL_PACKAGES } from "../node-compat/modules.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

/**
 * A project served by an in-browser "HTTP server" (webrun-site-builder handler, hosted in a
 * ServiceWorker by webrun-site-host): the browser's own module loader then fetches the
 * Worker code from real URLs — no bundling, no Blob URLs.
 *
 *   GET  /modules/~/<path>        the project's sources compiled to ESM by webrun-modules
 *   PUT  /loaded-src/<id>/<file>  a Worker Loader stores the modules of loaded code
 *   GET  /loaded/<id>/~/<file>    loaded code compiled to ESM by webrun-modules
 *   GET  /src/<path>              raw project files
 *
 * `cloudflare:workers` and the Workers globals (`Response` with status 101, `WebSocketPair`)
 * are webrun-modules `~deps` proxies that read `globalThis.__webrunHostRegistry` in the realm
 * that imports the code (see `workersHostRegistry`). Each loaded Worker gets its own module
 * server whose `console` proxy selects that Worker's console (Tail Workers).
 */
export const LOADED_CONSOLES = "__cellsLoadedConsoles";

export function createProjectSite(opts: {
  projectFiles: FilesApi;
  nodeCompat?: boolean;
  /**
   * The `node:*` registry entries of the realm that runs the code (`nodeRegistryEntries`): a
   * namespace import (`import * as assert from "node:assert"`) exports the keys the server
   * sees here, so without them its members are undefined.
   */
  nodeModules?: Record<string, unknown>;
}): SiteHandler {
  const host = "globalThis.__webrunHostRegistry.get";
  // nodejs_compat: node:* and the Buffer/process globals come from the realm's registry too.
  const provided: Record<string, object> = { "cloudflare:workers": {} };
  if (opts.nodeCompat)
    for (const name of [
      ...Object.keys(NODE_POLYFILL_PACKAGES),
      ...Object.keys(NODE_POLYFILL_FILES),
    ])
      provided[name] = (opts.nodeModules?.[name] as object) ?? {};
  const globals = {
    ...Object.fromEntries(WORKERS_GLOBAL_NAMES.map((n) => [n, `${host}(${JSON.stringify(n)})`])),
    scheduler: SCHEDULER_EXPRESSION,
    ...(opts.nodeCompat ? { Buffer: `${host}("Buffer")`, process: `${host}("process")` } : {}),
  };
  const modules = newModuleServer({
    cache: new MemFilesApi(),
    project: opts.projectFiles,
    basePath: "/modules/",
    target: "browser",
    provided,
    globals,
  });
  // One module server per loaded Worker: its globals proxy (one per project root in
  // webrun-modules) can then bind `console` to that Worker's own console (Tail Workers).
  // `esm`: modules stored as ESM already (text, json, wasm entries), served as they are: the
  // module server would serve `math.wasm` or `text.txt` by their extension.
  const loaded = new Map<
    string,
    { files: FilesApi; server: ReturnType<typeof newModuleServer>; esm: Set<string> }
  >();
  const loadedFor = (id: string) => {
    let l = loaded.get(id);
    if (!l) {
      const files = new MemFilesApi();
      const server = newModuleServer({
        cache: new MemFilesApi(),
        project: files,
        basePath: `/loaded/${encodeURIComponent(id)}/`,
        target: "browser",
        provided,
        globals: {
          ...globals,
          console: `(globalThis.${LOADED_CONSOLES}?.[${JSON.stringify(id)}] ?? globalThis.console)`,
          fetch: `(globalThis.__cellsLoadedOutbound?.[${JSON.stringify(id)}] ?? globalThis.fetch)`,
        },
      });
      l = { files, server, esm: new Set() };
      loaded.set(id, l);
    }
    return l;
  };
  return new SiteBuilder()
    .setEndpoint("/modules/*", (req) => modules.fetch(req))
    .setEndpoint("/loaded/:id/*", async (req, env) => {
      const l = loadedFor(decodeURIComponent(String(env.params.id)));
      const path = decodeURIComponent(
        new URL(req.url).pathname.slice(`/loaded/${env.params.id}/~`.length),
      );
      if (!l.esm.has(path)) return l.server.fetch(req);
      return new Response(await readText(l.files, path), {
        headers: { "content-type": "text/javascript" },
      });
    })
    .setEndpoint("/loaded-src/:id/*", "PUT", async (req, env) => {
      const id = decodeURIComponent(String(env.params.id));
      const path = decodeURIComponent(
        new URL(req.url).pathname.slice(`/loaded-src/${env.params.id}`.length),
      );
      const l = loadedFor(id);
      await l.files.write(path, [new Uint8Array(await req.arrayBuffer())]);
      if (req.headers.has(ESM_HEADER)) l.esm.add(path);
      return new Response(null, { status: 204 });
    })
    .setFiles("/src", opts.projectFiles)
    .build();
}

/** The registry the `~deps` proxies read, for the realm that runs the Worker code. */
export function workersHostRegistry(entries: {
  /** nodejs_compat: "node:buffer" → module namespace, and the Buffer/process globals. */
  node?: Record<string, unknown>;
  workersModule: unknown;
  Response: unknown;
  WebSocketPair: unknown;
  caches: unknown;
  HTMLRewriter: unknown;
  WebSocketRequestResponsePair?: unknown;
}): void {
  const map = new Map<string, unknown>([
    ["cloudflare:workers", entries.workersModule],
    ...WORKERS_GLOBAL_NAMES.map((n) => [n, entries[n]] as const),
    ...Object.entries(entries.node ?? {}),
  ]);
  (globalThis as Record<string, unknown>).__webrunHostRegistry = {
    get: (k: string) => map.get(k),
    has: (k: string) => map.has(k),
    set: (k: string, v: unknown) => void map.set(k, v),
  };
}

const ESM_HEADER = "x-cellb-esm";

/**
 * Stores one module of loaded code on the site (PUT /loaded-src/<id>/<name>). Source goes
 * through webrun-modules; a text, json or wasm entry is stored as the ESM that wraps it.
 */
export function putLoadedModule(url: string, m: WorkerCode["modules"][string]): Promise<Response> {
  const wrapped = typeof m === "object" && !("js" in m) && !("esModule" in m);
  return fetch(url, {
    method: "PUT",
    body: moduleText(m),
    headers: wrapped ? { [ESM_HEADER]: "1" } : {},
  });
}

/**
 * Worker Loader over the site: `LOADER.get(id, () => code)` uploads the modules to
 * `/loaded-src/<id>/…` and imports `/loaded/<id>/~/<main>` — compiled by webrun-modules and
 * fetched by the browser like any other module. Works in pages, workers and ServiceWorkers.
 */
export function siteModuleLoader(baseUrl: string): ModuleLoader {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return async (id: string, code: WorkerCode, logs?: LogSink) => {
    const dir = encodeURIComponent(id);
    for (const [name, m] of Object.entries(code.modules)) {
      const res = await putLoadedModule(`${base}loaded-src/${dir}/${name}`, m);
      if (!res.ok) throw new Error(`Worker Loader: cannot store ${id}/${name}: ${res.status}`);
    }
    const outbound = outboundFetch(code);
    if (outbound) {
      const g = globalThis as Record<string, unknown>;
      g.__cellsLoadedOutbound ??= {};
      (g.__cellsLoadedOutbound as Record<string, unknown>)[id] = outbound;
    }
    if (logs) {
      const g = globalThis as Record<string, unknown>;
      g[LOADED_CONSOLES] ??= {};
      const real = globalThis.console;
      const wrap =
        (level: "log" | "info" | "warn" | "error" | "debug") =>
        (...args: unknown[]) => {
          logs(level, args);
          real[level](...args);
        };
      (g[LOADED_CONSOLES] as Record<string, unknown>)[id] = Object.assign(Object.create(real), {
        log: wrap("log"),
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
        debug: wrap("debug"),
      });
    }
    return (await import(/* @vite-ignore */ `${base}loaded/${dir}/~/${code.mainModule}`)) as Record<
      string,
      unknown
    >;
  };
}
