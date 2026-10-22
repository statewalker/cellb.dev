// A worker thread hosting ONE loaded Worker (an isolate); see src/isolate/protocol.ts.
import { parentPort } from "node:worker_threads";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";

serveIsolate(
  parentPort as unknown as PortLike,
  async ({ source }) =>
    import(`data:text/javascript;base64,${Buffer.from(source ?? "").toString("base64")}`),
);
