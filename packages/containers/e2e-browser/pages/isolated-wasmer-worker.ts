/// <reference lib="webworker" />
// One isolated container per Web Worker: a Wasmer client of its own.
import { Wasmer } from "@wasmer/sdk/browser";
import { wasmerWorkerEngine } from "../../src/engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(self as never, ({ files }) => wasmerWorkerEngine(new Wasmer(), files));
