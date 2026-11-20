// One isolated container's worker running Lifo (a Linux-like OS in TypeScript: shell, Node-compatible JS).
import { parentPort } from "node:worker_threads";
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(parentPort as never, ({ files }) =>
  lifoContainerEngine(lifo as never, { files }),
);
