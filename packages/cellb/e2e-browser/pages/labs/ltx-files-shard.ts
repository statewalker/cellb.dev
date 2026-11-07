/// <reference lib="webworker" />
// A shard worker on the app's own FilesApi: SQLite on the LTX VFS (browser-host's ltxOpener),
// its store either a store worker of its own reaching the page's FilesApi through a port
// (`files: { port }`), or the store the page runs (`ltxStore: { sab, port }`).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { ltxOpener } from "../../../src/project/browser-host.ts";

self.onmessage = async (e: MessageEvent) => {
  const { files, ltxStore, sql } = e.data as {
    files?: { port: MessagePort } | { module: string; args?: unknown };
    ltxStore?: { sab: SharedArrayBuffer; port: MessagePort };
    sql: string[];
  };
  try {
    const sqlite3: any = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const open = await ltxOpener(sqlite3, "app-files", undefined, files, ltxStore);
    const db = open("Notes/0001");
    const results = sql.map((s) => db.exec(s, []).rows);
    db.close();
    open.release();
    postMessage({ ok: true, results });
  } catch (err) {
    postMessage({ ok: false, error: String((err as Error)?.stack ?? err).slice(0, 800) });
  }
};
