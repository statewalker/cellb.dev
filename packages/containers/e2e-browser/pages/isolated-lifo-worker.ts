/// <reference lib="webworker" />
// One isolated container per Web Worker: a Lifo box (shell, Node-compatible JS).
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(self as never, ({ files }) => lifoContainerEngine(lifo as never, { files }));
