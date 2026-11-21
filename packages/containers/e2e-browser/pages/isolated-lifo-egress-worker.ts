/// <reference lib="webworker" />
// A Lifo container whose engine allows egress (for build steps): a container started with
// enableInternet reaches the network through this worker's fetch.
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../src/worker.ts";

serveContainerWorker(self as never, ({ files }) =>
  lifoContainerEngine(lifo as never, { files, egress: "host" }),
);
