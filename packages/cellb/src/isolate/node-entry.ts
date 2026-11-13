// A worker thread hosting ONE loaded Worker (an isolate); see src/isolate/protocol.ts.
import * as nodeModule from "node:module";
import { parentPort } from "node:worker_threads";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import { loadedModuleShim, resolveModuleName } from "../bindings/module-registry.js";
import {
  CellsRequest,
  CellsResponse,
  WebSocket,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../project/workers-globals-module.js";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";
import { makeGlobalsWritable } from "./writable-globals.js";

// An exception no request awaits (a timer, ctx.abort() from one) is reported, and the isolate
// lives on, as in a browser Dedicated Worker and workerd; Node would end the thread.
process.on("uncaughtException", (e) => console.error("Uncaught", e));

// workerd lets Worker code assign its globals (Kitesurf's DOM shim sets `navigator` and
// `location`); this realm's getter-only ones become writable (writable-globals.ts).
makeGlobalsWritable();

// `import()` in code the loaded Worker builds with `Function` (Kitesurf imports page modules so)
// names its modules as on workerd, but no bundler saw it: this thread's module hooks resolve such
// a specifier against the loaded Worker's modules (the registry its bundle publishes) and load a
// shim that re-exports the bundled module. `registerHooks` is in Node 22.15 and later.
const LOADED = "cellb-loaded:";
type LoadedModules = { main: string; names: Set<string>; exportNames: Record<string, string[]> };
const registerHooks = (nodeModule as { registerHooks?: (hooks: object) => unknown }).registerHooks;
registerHooks?.({
  resolve(spec: string, context: { parentURL?: string }, next: (s: string, c: object) => unknown) {
    const loaded = (globalThis as { __cellbLoadedModules?: LoadedModules }).__cellbLoadedModules;
    const fromBundle = !context.parentURL || context.parentURL.startsWith("data:");
    const name =
      loaded && fromBundle ? resolveModuleName(spec, loaded.main, loaded.names) : undefined;
    if (name === undefined) return next(spec, context);
    return { url: LOADED + encodeURIComponent(name), shortCircuit: true };
  },
  load(url: string, context: object, next: (u: string, c: object) => unknown) {
    if (!url.startsWith(LOADED)) return next(url, context);
    const name = decodeURIComponent(url.slice(LOADED.length));
    const loaded = (globalThis as { __cellbLoadedModules?: LoadedModules }).__cellbLoadedModules;
    return {
      format: "module",
      shortCircuit: true,
      source: loadedModuleShim(name, loaded?.exportNames[name] ?? []),
    };
  },
});

// This thread is the loaded Worker's realm: its globals are the Workers ones, as in a browser
// isolate (src/isolate/isolate-worker.ts). A `Response` that takes `{ status: 101, webSocket }`
// and a `WebSocketPair` are what a Worker that accepts WebSockets needs.
Object.assign(globalThis, {
  Request: CellsRequest,
  Response: CellsResponse,
  WebSocket,
  WebSocketPair,
  WebSocketRequestResponsePair,
});

serveIsolate(
  parentPort as unknown as PortLike,
  async ({ source }) =>
    import(`data:text/javascript;base64,${Buffer.from(source ?? "").toString("base64")}`),
  // Facets of the loaded code keep their SQLite here: files under `dataDir` when the host
  // gives one, else temporary files (lost with the isolate, as in memory). The isolate logs
  // every commit's pages to its host, so they are read from the WAL, not from an image.
  { openSql: (load) => nodeSqliteOpener(load?.dataDir, { pageCapture: true }) },
);
