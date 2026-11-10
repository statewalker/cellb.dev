import {
  type LogSink,
  type ModuleLoader,
  moduleText,
  outboundFetch,
  type WorkerCode,
} from "../bindings/worker-loader.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

/**
 * The runtime side of a project site (`createProjectSite`, in `@statewalker/cellb/site`): the
 * registry its `~deps` proxies read, and the Worker Loader that uploads code to it. Nothing here
 * compiles code, so the browser host and the isolates import this module without pulling in
 * webrun-modules (and lightningcss-wasm) — only projects that build a site do.
 */
export const LOADED_CONSOLES = "__cellsLoadedConsoles";

/** What `cloudflare:workers` exports on a site (`env` and `exports` are a project's own). */
export const WORKERS_MODULE_NAMES = [
  "DurableObject",
  "WorkerEntrypoint",
  "WorkflowEntrypoint",
  "RpcTarget",
  "env",
  "exports",
  "waitUntil",
];

/**
 * The registry the `~deps` proxies read, for the realm that runs the Worker code. The project
 * and the Workers it loads share this realm's registry, but not their proxies: each has its own
 * module server, so a proxy of loaded code is a module under `<site>loaded/`. A proxy reads the
 * registry while it is evaluated, so the caller on the stack tells whose it is: loaded code gets
 * `workersModule` (`env` and `exports` empty), the project `projectWorkersModule` (its own).
 */
export function workersHostRegistry(entries: {
  /** nodejs_compat: "node:buffer" → module namespace, and the Buffer/process globals. */
  node?: Record<string, unknown>;
  workersModule: object;
  /** With `loadedPrefix` (`<site>loaded/`): the project's own `cloudflare:workers`. */
  projectWorkersModule?: object;
  loadedPrefix?: string;
  emailModule?: unknown;
  Request: unknown;
  Response: unknown;
  WebSocketPair: unknown;
  caches: unknown;
  HTMLRewriter: unknown;
  WebSocketRequestResponsePair?: unknown;
  WebSocket?: unknown;
}): void {
  const map = new Map<string, unknown>([
    ["cloudflare:workers", { env: {}, exports: {}, waitUntil: () => {}, ...entries.workersModule }],
    ["cloudflare:email", entries.emailModule],
    ...WORKERS_GLOBAL_NAMES.map((n) => [n, entries[n]] as const),
    ...Object.entries(entries.node ?? {}),
  ]);
  const { projectWorkersModule: project, loadedPrefix } = entries;
  (globalThis as Record<string, unknown>).__webrunHostRegistry = {
    get: (k: string) =>
      k === "cloudflare:workers" && project && loadedPrefix
        ? (new Error().stack ?? "").includes(loadedPrefix)
          ? map.get(k)
          : project
        : map.get(k),
    has: (k: string) => map.has(k),
    set: (k: string, v: unknown) => void map.set(k, v),
  };
}

export const ESM_HEADER = "x-cellb-esm";

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
