// A worker thread hosting ONE loaded Worker (an isolate); see src/isolate/protocol.ts.
import { parentPort } from "node:worker_threads";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";

serveIsolate(
  parentPort as unknown as PortLike,
  async ({ source }) =>
    import(`data:text/javascript;base64,${Buffer.from(source ?? "").toString("base64")}`),
  // Facets of the loaded code keep their SQLite here: files under `dataDir` when the host
  // gives one, else in memory (lost with the isolate).
  { openSql: (load) => nodeSqliteOpener(load?.dataDir) },
);
