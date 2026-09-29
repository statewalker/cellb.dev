// Entry of the "cell host" thread: stands in for the browser Dedicated Worker.
import { parentPort, workerData } from "node:worker_threads";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime, serveRuntime } from "../src/index.js";
import { worker } from "./fixtures.js";

const runtime = createCellRuntime({
  worker,
  durableObjects: { COUNTER: { className: "Counter" } },
  openSql: nodeSqliteOpener(workerData.dir),
});
await serveRuntime(workerData.port, runtime);
parentPort!.postMessage("ready");
