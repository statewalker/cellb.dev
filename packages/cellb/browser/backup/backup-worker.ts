/// <reference lib="webworker" />
// P06a in the browser: cells on an OPFS sahpool, periodic backup to an OPFS FilesApi
// (webrun-files-browser), restore-on-open through sahpool importDb.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { filesApiBackup } from "../../src/adapters/files-backup.js";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import { type CellRuntime, createCellRuntime } from "../../src/index.js";
import { worker } from "../../test/fixtures.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let rt: CellRuntime | undefined;
const counter = (name: string) => {
  if (!rt) throw new Error("not initialized");
  return (rt.env.COUNTER as any).getByName(name);
};

scope.onmessage = async (e) => {
  const m = e.data;
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    if (m.op === "init") {
      const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr: console.error });
      const openSql = await sahpoolOpener(sqlite3, { name: m.pool });
      const root = await navigator.storage.getDirectory();
      const files = new BrowserFilesApi({
        rootHandle: await root.getDirectoryHandle("cells-backups", { create: true }),
      });
      rt = createCellRuntime({
        worker,
        durableObjects: { COUNTER: { className: "Counter" } },
        openSql,
        backup: m.backup ? filesApiBackup(files, { intervalMs: 60_000 }) : undefined,
      });
      reply({ ok: true });
    } else if (m.op === "inc") reply({ ok: true, v: await counter(m.name).increment(m.by ?? 1) });
    else if (m.op === "value") reply({ ok: true, v: await counter(m.name).value() });
    else if (m.op === "backupNow") reply({ ok: true, v: await rt?.backupNow() });
    else if (m.op === "close") reply({ ok: true, v: await rt?.close() });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
