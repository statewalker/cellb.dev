// One isolated container's worker: a Wasmer client of its own, served with serveContainerWorker.
import { parentPort } from "node:worker_threads";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerWorkerEngine } from "../../src/engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(parentPort as never, ({ files }) =>
  wasmerWorkerEngine(new Wasmer({ cache: { directory: ".wasmer" } }), files),
);
