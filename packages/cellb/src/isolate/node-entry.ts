// A worker thread hosting ONE loaded Worker (an isolate); see src/isolate/protocol.ts.
import { parentPort } from "node:worker_threads";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import * as cloudflareEmail from "../project/cloudflare-email.js";
import * as workersModule from "../project/cloudflare-workers.js";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";

// An exception no request awaits (a timer, ctx.abort() from one) is reported, and the isolate
// lives on, as in a browser Dedicated Worker and workerd; Node would end the thread.
// The loaded Worker's `cloudflare:workers` and `cloudflare:email` read this thread's runtime.
(globalThis as Record<string, unknown>).__cellsWorkersModule = workersModule;
(globalThis as Record<string, unknown>).__cellsEmailModule = cloudflareEmail;

process.on("uncaughtException", (e) => console.error("Uncaught", e));

serveIsolate(
  parentPort as unknown as PortLike,
  async ({ source }) =>
    import(`data:text/javascript;base64,${Buffer.from(source ?? "").toString("base64")}`),
  // Facets of the loaded code keep their SQLite here: files under `dataDir` when the host
  // gives one, else in memory (lost with the isolate).
  { openSql: (load) => nodeSqliteOpener(load?.dataDir) },
);
