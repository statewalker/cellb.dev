/// <reference lib="webworker" />
// The notebook's container: Lifo with no network.
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../../src/worker.ts";

serveContainerWorker(self as never, ({ files }) => lifoContainerEngine(lifo as never, { files }));
