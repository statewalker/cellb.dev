// A worker thread hosting ONE loaded Worker (an isolate); see src/isolate/protocol.ts.
import { parentPort } from "node:worker_threads";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import {
  CellsRequest,
  CellsResponse,
  WebSocket,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../project/workers-globals-module.js";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";

// An exception no request awaits (a timer, ctx.abort() from one) is reported, and the isolate
// lives on, as in a browser Dedicated Worker and workerd; Node would end the thread.
process.on("uncaughtException", (e) => console.error("Uncaught", e));

// workerd lets Worker code assign `navigator` (Kitesurf's DOM shim does); this realm's own is a
// getter only (Node's global, a Dedicated Worker's WorkerGlobalScope). The isolate is the loaded
// Worker's realm, so the global becomes a plain writable property with the same value.
Object.defineProperty(globalThis, "navigator", {
  value: globalThis.navigator,
  writable: true,
  configurable: true,
  enumerable: true,
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
