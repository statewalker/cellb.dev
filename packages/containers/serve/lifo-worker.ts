// The worker of `serve/lifo.ts`: Lifo's engine in a realm of its own. Lifo guards its realm's
// network (no egress unless a container asks for it), which must not be the node's realm: the
// node reaches its bucket and its peers with fetch.
import { parentPort } from "node:worker_threads";
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../src/lifo-engine.ts";
import { serveContainerWorker } from "../src/worker.ts";

serveContainerWorker(parentPort as never, ({ files }) =>
  lifoContainerEngine(lifo as never, { files }),
);
