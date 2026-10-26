// A shard worker thread (stand-in for a browser Dedicated Worker hosting one shard).
import { parentPort, workerData } from "node:worker_threads";
import { createShardWorker } from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import { worker } from "./fixtures.js";

const host = createShardWorker({
  shard: workerData.shard,
  shards: workerData.shards,
  worker,
  durableObjects: { COUNTER: { className: "Counter" }, ROOM: { className: "Room" } },
  openSql: nodeSqliteOpener(workerData.dir),
});
parentPort!.on("message", async (m) => {
  if (m?.type === "link") {
    await host.link(m.down, m.up, m.ctl);
    parentPort!.postMessage({ type: "linked" });
  }
});
parentPort!.postMessage({ type: "booted" });
