/// <reference lib="webworker" />
// The build step's container: Lifo with egress (the page's network), for npm install.
import * as lifo from "@lifo-sh/core";
import { lifoContainerEngine } from "../../../src/lifo-engine.ts";
import { serveContainerWorker } from "../../../src/worker.ts";

serveContainerWorker(self as never, ({ files }) =>
  lifoContainerEngine(lifo as never, { files, egress: "host" }),
);
