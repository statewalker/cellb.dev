/// <reference lib="webworker" />
// P04c — Dedicated Worker hosting the cells: SQLite WASM + OPFS sahpool, served over the worker port.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../src/adapters/wasm-sqlite.js";
import { createCellRuntime, serveRuntime } from "../src/index.js";
import { worker } from "../test/fixtures.js";

const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr: console.error });
const openSql = await sahpoolOpener(sqlite3, { name: "webrun-cells-e2e", initialCapacity: 16 });

const runtime = createCellRuntime({
  worker,
  durableObjects: { COUNTER: { className: "Counter" } },
  openSql,
});
// The page transfers a dedicated MessagePort: the worker's own channel stays free for control messages.
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener("message", async (e) => {
  if (e.data?.type !== "cells-connect") return;
  await serveRuntime(e.data.port as MessagePort, runtime);
  scope.postMessage({ type: "cells-ready" });
});
scope.postMessage({ type: "cells-booted" });
