/// <reference lib="webworker" />
// SQLite in this worker, synchronously, over a cell's LTX files that the page reads and writes
// asynchronously (ltxPageServer): the LTX VFS blocks on a SharedArrayBuffer per page miss.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { installLtxVfs } from "../../../packages/cellb/src/adapters/ltx-vfs.ts";

self.onmessage = async (
  e: MessageEvent<{
    sab: SharedArrayBuffer;
    port: MessagePort;
    script: string;
    cachePages?: number;
  }>,
) => {
  const { sab, port, script } = e.data;
  try {
    const sqlite3: any = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const { name, stats } = installLtxVfs(
      sqlite3,
      { sab, post: (m) => port.postMessage(m) },
      { cachePages: e.data.cachePages },
    );
    const db = new sqlite3.oo1.DB({ filename: "cell.db", vfs: name, flags: "c" });
    db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=FULL; PRAGMA cache_size=0;");
    const t0 = performance.now();
    const out = new Function("db", script)(db);
    const ms = performance.now() - t0;
    db.close();
    postMessage({
      ok: true,
      out,
      ms: Math.round(ms),
      stats: { ...stats, blockedMs: Math.round(stats.blockedMs) },
    });
  } catch (err) {
    postMessage({ ok: false, error: String((err as Error)?.stack ?? err).slice(0, 800) });
  }
};
