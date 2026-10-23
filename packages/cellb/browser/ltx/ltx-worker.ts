/// <reference lib="webworker" />
// LTX log in the browser: cells on SQLite WASM (OPFS sahpool) with the page hook; every
// commit becomes an LTX file (changed pages only) on an OPFS FilesApi. A worker with an EMPTY
// pool rebuilds the cells from that log alone.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import {
  createCellRuntime,
  DurableObject,
  decodeLtx,
  filesApiLtxLog,
  runInDurableObject,
} from "../../src/index.js";

class Notes extends DurableObject {
  seed() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS bulk (v TEXT)");
    for (let i = 0; i < 2000; i++) sql.exec("INSERT INTO bulk VALUES (?)", `row ${i} `.repeat(20));
  }
  add(text: string) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS tags (tag TEXT)"); // no PRIMARY KEY: ROWID capture
    sql.exec("INSERT INTO notes (text) VALUES (?)", text);
    sql.exec("INSERT INTO tags VALUES (?)", text.slice(0, 1));
    this.ctx.storage.kv.put(`last`, text);
  }
  dump() {
    const sql = this.ctx.storage.sql;
    return {
      notes: sql.exec("SELECT id, text FROM notes ORDER BY id").toArray(),
      tags: sql.exec("SELECT tag FROM tags ORDER BY rowid").toArray(),
      last: this.ctx.storage.kv.get("last"),
    };
  }
}

self.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    const { pool, op, texts, logDir } = e.data as {
      pool: string;
      op: "add" | "dump";
      texts?: string[];
      logDir: string;
    };
    const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const openSql = await sahpoolOpener(sqlite3, { name: pool });
    const root = await navigator.storage.getDirectory();
    const files = new BrowserFilesApi({
      rootHandle: await root.getDirectoryHandle(logDir, { create: true }),
    });
    const log = filesApiLtxLog(files);
    const rt = createCellRuntime({
      worker: { Notes, default: {} },
      durableObjects: { NOTES: { className: "Notes" } },
      openSql,
      durability: log,
      backup: log,
    });
    const stub = (rt.env.NOTES as any).getByName("n");
    if (op === "add") {
      await runInDurableObject(stub, (o: Notes) => o.seed()); // many pages: commits touch few
      for (const t of texts ?? []) await runInDurableObject(stub, (o: Notes) => o.add(t));
    }
    const ltx: { name: string; pages: number; commit: number }[] = [];
    for await (const f of files.list("/cells", { recursive: true }))
      if (f.path.endsWith(".ltx")) {
        const chunks: Uint8Array[] = [];
        for await (const c of files.read(f.path)) chunks.push(c);
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          bytes.set(c, o);
          o += c.length;
        }
        const d = decodeLtx(bytes);
        ltx.push({ name: f.path.split("/").pop()!, pages: d.pages.size, commit: d.header.commit });
      }
    ltx.sort((a, b) => a.name.localeCompare(b.name));
    reply({ ok: true, dump: await runInDurableObject(stub, (o: Notes) => o.dump()), ltx });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
