/// <reference lib="webworker" />
// One shard: its own opfs-sahpool (pools are exclusive per worker), its own cells.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import { createShardHost, type ShardHost } from "../../src/index.js";
import { worker } from "../../test/fixtures.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let host: ShardHost | undefined;

scope.addEventListener("message", async (e) => {
  const m = e.data;
  if (m?.type === "init") {
    const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr: console.error });
    const openSql = await sahpoolOpener(sqlite3, { name: `webrun-cells-shard-${m.shard}` });
    host = createShardHost({
      shard: m.shard,
      shards: m.shards,
      worker,
      durableObjects: { COUNTER: { className: "Counter" } },
      openSql,
    });
    // A lock only this worker holds: released by the browser the moment the worker
    // (or its tab) dies — the router's liveness signal (MessagePorts report nothing).
    const ownerLock = `webrun-cells:owner:${m.shard}:${crypto.randomUUID()}`;
    await new Promise<void>(
      (held) => void navigator.locks.request(ownerLock, () => (held(), new Promise(() => {}))),
    );
    scope.postMessage({ type: "ready", ownerLock });
  } else if (m?.type === "link") {
    await host!.link(m.down, m.up);
    scope.postMessage({ type: "linked" });
  }
});
