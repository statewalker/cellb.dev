// A run container's worker: a Wasmer client (edgejs is chosen by the pool's image). No egress.
import { parentPort } from "node:worker_threads";
import { Wasmer } from "@wasmer/sdk/node";
import { wasmerWorkerEngine } from "../../src/engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(parentPort as never, ({ files }) =>
  wasmerWorkerEngine(new Wasmer({ cache: { directory: ".wasmer" } }), files),
);
