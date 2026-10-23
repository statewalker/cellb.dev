import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import {
  type LogSink,
  type ModuleLoader,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { NODE_POLYFILL_FILES, NODE_POLYFILL_PACKAGES } from "../node-compat/modules.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";

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
}): SiteHandler {
  const host = "globalThis.__webrunHostRegistry.get";
  // nodejs_compat: node:* and the Buffer/process globals come from the realm's registry too.
  const provided: Record<string, object> = { "cloudflare:workers": {} };
  if (opts.nodeCompat)
    for (const name of [
      ...Object.keys(NODE_POLYFILL_PACKAGES),
      ...Object.keys(NODE_POLYFILL_FILES),
    ])
      provided[nodeAlias(name)] = {};
  const globals = {
    Response: `${host}("Response")`,
    WebSocketPair: `${host}("WebSocketPair")`,
    caches: `${host}("caches")`,
    HTMLRewriter: `${host}("HTMLRewriter")`,
    WebSocketRequestResponsePair: `${host}("WebSocketRequestResponsePair")`,
    scheduler: SCHEDULER_EXPRESSION,
    ...(opts.nodeCompat ? { Buffer: `${host}("Buffer")`, process: `${host}("process")` } : {}),
  };
  const modules = newModuleServer({
    cache: new MemFilesApi(),
    project: opts.nodeCompat ? withNodeAliases(opts.projectFiles) : opts.projectFiles,
    basePath: "/modules/",
    target: "browser",
    provided,
    globals,
  });
  // One module server per loaded Worker: its globals proxy (one per project root in
  // webrun-modules) can then bind `console` to that Worker's own console (Tail Workers).
  const loaded = new Map<string, { files: FilesApi; server: ReturnType<typeof newModuleServer> }>();
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
      l = { files, server };
      loaded.set(id, l);
    }
    return l;
  };
  return new SiteBuilder()
    .setEndpoint("/modules/*", (req) => modules.fetch(req))
    .setEndpoint("/loaded/:id/*", (req, env) =>
      loadedFor(decodeURIComponent(String(env.params.id))).server.fetch(req),
    )
    .setEndpoint("/loaded-src/:id/*", "PUT", async (req, env) => {
      const id = decodeURIComponent(String(env.params.id));
      const path = decodeURIComponent(
        new URL(req.url).pathname.slice(`/loaded-src/${env.params.id}`.length),
      );
      await loadedFor(id).files.write(path, [new Uint8Array(await req.arrayBuffer())]);
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
    ["Response", entries.Response],
    ["WebSocketPair", entries.WebSocketPair],
    ["caches", entries.caches],
    ["HTMLRewriter", entries.HTMLRewriter],
    ["WebSocketRequestResponsePair", entries.WebSocketRequestResponsePair],
    ...Object.entries(entries.node ?? {}),
  ]);
  (globalThis as Record<string, unknown>).__webrunHostRegistry = {
    get: (k: string) => map.get(k),
    has: (k: string) => map.has(k),
    set: (k: string, v: unknown) => void map.set(k, v),
  };
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
      const text =
        typeof m === "string"
          ? m
          : (m.js ?? m.esModule ?? `export default ${JSON.stringify(m.text ?? m.json)};`);
      const res = await fetch(`${base}loaded-src/${dir}/${name}`, { method: "PUT", body: text });
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

/**
 * webrun-modules resolves `node:*` to its own polyfills (jspm nodelibs) BEFORE host-provided
 * names, and those lack parts of what nodejs_compat offers (e.g. crypto.timingSafeEqual).
 * Served sources therefore have `node:x` rewritten to `cells-node-x`, a provided name the
 * worker's registry binds to webrun-cells' polyfills. (Upstream fix: let provided names win.)
 */
export const nodeAlias = (name: string) => `cells-node-${name.slice("node:".length)}`;

const SOURCE = /\.(m?js|ts|jsx|tsx)$/;
function withNodeAliases(files: FilesApi): FilesApi {
  return new Proxy(files, {
    get(target, prop, receiver) {
      if (prop !== "read") return Reflect.get(target, prop, receiver);
      return (path: string, options?: unknown) => {
        const inner = target.read(path, options as never);
        if (!SOURCE.test(path) || options) return inner;
        return (async function* () {
          const chunks: Uint8Array[] = [];
          for await (const c of inner) chunks.push(c);
          const text = new TextDecoder().decode(
            chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.flatMap((c) => [...c])),
          );
          yield new TextEncoder().encode(
            text.replace(
              /(["'])node:([\w/]+)\1/g,
              (_m, q, n) => `${q}${nodeAlias(`node:${n}`)}${q}`,
            ),
          );
        })();
      };
    },
  });
}
