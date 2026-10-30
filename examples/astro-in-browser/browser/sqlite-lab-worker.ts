/// <reference lib="webworker" />
// One SQLite "cell" per worker, in one of several storage modes; N of these run at once
// (sqlite-lab.html). Each: open, create a table, K single-row write transactions, read back.
//
// - sahpool-own:    OPFS SyncAccessHandle pool, one pool (name) per worker
// - sahpool-shared: the same pool name in every worker (exclusive: expected to fail past one)
// - opfs:           SQLite's "opfs" VFS (async OPFS proxied through SharedArrayBuffer + Atomics)
// - opfs-same:      the "opfs" VFS, every worker on the SAME database file
// - memdb-pages:    in-memory database + page hook: each commit's changed pages appended to an
//                   OPFS log file through the ASYNC OPFS API (no sync handle), restored on open
// - memdb-pages-idb: the same, with the page log in IndexedDB
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { installPageHook } from "../../../packages/cellb/src/adapters/wasm-page-hook.ts";

type Msg = { mode: string; id: number; k: number; run: string };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { mode, id, k, run } = e.data;
  const t0 = performance.now();
  try {
    const sqlite3: any = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const tInit = performance.now() - t0;
    const r = await MODES[mode](sqlite3, id, k, run);
    postMessage({
      id,
      ok: true,
      initMs: Math.round(tInit),
      ms: Math.round(performance.now() - t0),
      ...r,
    });
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
};

function workload(db: any, k: number) {
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
  const t = performance.now();
  for (let i = 0; i < k; i++)
    db.exec({ sql: "INSERT INTO t (v) VALUES (?)", bind: [`row ${i} ${"x".repeat(100)}`] });
  const writeMs = performance.now() - t;
  const rows = db.selectValue("SELECT count(*) FROM t");
  return { writeMs: Math.round(writeMs), rows };
}

const MODES: Record<
  string,
  (s: any, id: number, k: number, run: string) => Promise<Record<string, unknown>>
> = {
  async "sahpool-own"(s, id, k, run) {
    const pool = await s.installOpfsSAHPoolVfs({ name: `lab-${run}-${id}`, initialCapacity: 4 });
    const db = new pool.OpfsSAHPoolDb(`/cell-${id}.db`);
    const r = workload(db, k);
    db.close();
    return r;
  },
  async "sahpool-shared"(s, id, k, run) {
    const pool = await s.installOpfsSAHPoolVfs({ name: `lab-${run}-shared`, initialCapacity: 64 });
    const db = new pool.OpfsSAHPoolDb(`/cell-${id}.db`);
    const r = workload(db, k);
    db.close();
    return r;
  },
  async opfs(s, id, k, run) {
    if (!s.oo1.OpfsDb) throw new Error("no opfs VFS (needs cross-origin isolation)");
    const db = new s.oo1.OpfsDb(`/lab-${run}/cell-${id}.db`, "c");
    const r = workload(db, k);
    db.close();
    return r;
  },
  async "opfs-same"(s, _id, k, run) {
    if (!s.oo1.OpfsDb) throw new Error("no opfs VFS (needs cross-origin isolation)");
    const db = new s.oo1.OpfsDb(`file:/lab-${run}/shared.db?opfs-unlock-asap=1`, "c");
    db.exec("PRAGMA busy_timeout = 10000");
    const r = workload(db, k);
    db.close();
    return r;
  },
  "memdb-pages": (s, id, k, run) => memdbPages(s, id, k, opfsLog(`lab-${run}-cell-${id}.log`)),
  "memdb-pages-idb": (s, id, k, run) => memdbPages(s, id, k, idbLog(`lab-${run}`, `cell-${id}`)),
};

/** An append-only page log: each commit = [pageSize u32, pageCount u32, n u32, n × (pgno u32, page)]. */
interface PageLog {
  read(): Promise<Uint8Array[]>;
  append(frame: Uint8Array): Promise<void>;
}

async function memdbPages(s: any, id: number, k: number, log: PageLog) {
  const db = new s.oo1.DB(`file:/lab-mem-${id}?vfs=memdb`, "c");
  // Restore: replay the log's frames onto an empty image.
  const frames = await log.read();
  if (frames.length) {
    let pageSize = 4096;
    let pageCount = 0;
    const pages = new Map<number, Uint8Array>();
    for (const f of frames) {
      const v = new DataView(f.buffer, f.byteOffset);
      pageSize = v.getUint32(0);
      pageCount = v.getUint32(4);
      const n = v.getUint32(8);
      for (let i = 0, at = 12; i < n; i++, at += 4 + pageSize)
        pages.set(v.getUint32(at), f.subarray(at + 4, at + 4 + pageSize));
    }
    const image = new Uint8Array(pageSize * pageCount);
    for (const [pg, b] of pages) if (pg <= pageCount) image.set(b, (pg - 1) * pageSize);
    const p = s.wasm.allocFromTypedArray(image);
    s.capi.sqlite3_deserialize(
      db.pointer,
      "main",
      p,
      image.length,
      image.length,
      s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
  }
  const hook = installPageHook(s, db.pointer);
  if (!hook) throw new Error("no page hook for this database");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
  let bytes = 0;
  const commit = async () => {
    const ps = Number(db.selectValue("PRAGMA page_size"));
    const pc = Number(db.selectValue("PRAGMA page_count"));
    const { pages } = hook.take(ps, pc);
    hook.discard();
    const frame = new Uint8Array(12 + pages.size * (4 + ps));
    const v = new DataView(frame.buffer);
    v.setUint32(0, ps), v.setUint32(4, pc), v.setUint32(8, pages.size);
    let at = 12;
    for (const [pg, b] of pages) v.setUint32(at, pg), frame.set(b, at + 4), (at += 4 + ps);
    bytes += frame.length;
    await log.append(frame);
  };
  await commit();
  const t = performance.now();
  for (let i = 0; i < k; i++) {
    db.exec({ sql: "INSERT INTO t (v) VALUES (?)", bind: [`row ${i} ${"x".repeat(100)}`] });
    await commit(); // durable before the next transaction, as an output gate would
  }
  const writeMs = performance.now() - t;
  const rows = db.selectValue("SELECT count(*) FROM t");
  db.close();
  return { writeMs: Math.round(writeMs), rows, logBytes: bytes, restoredFrames: frames.length };
}

function opfsLog(name: string): PageLog {
  const file = async () =>
    (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
  let size = -1;
  return {
    async read() {
      const f = await (await file()).getFile();
      const all = new Uint8Array(await f.arrayBuffer());
      size = all.length;
      return splitFrames(all);
    },
    async append(frame) {
      const h = await file();
      if (size < 0) size = (await h.getFile()).size;
      const w = await h.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: size, data: lenPrefixed(frame) });
      await w.close();
      size += frame.length + 4;
    },
  };
}

function idbLog(dbName: string, key: string): PageLog {
  const open = () =>
    new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore("frames", { autoIncrement: true }).createIndex("cell", "cell");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  let db: Promise<IDBDatabase> | undefined;
  const tx = async (mode: IDBTransactionMode) =>
    (await (db ??= open())).transaction("frames", mode).objectStore("frames");
  return {
    async read() {
      const store = await tx("readonly");
      return new Promise((res) => {
        const r = store.index("cell").getAll(key);
        r.onsuccess = () => res(r.result.map((x: { frame: Uint8Array }) => x.frame));
      });
    },
    async append(frame) {
      const store = await tx("readwrite");
      await new Promise<void>((res, rej) => {
        store.add({ cell: key, frame });
        store.transaction.oncomplete = () => res();
        store.transaction.onerror = () => rej(store.transaction.error);
      });
    },
  };
}

const lenPrefixed = (f: Uint8Array) => {
  const out = new Uint8Array(4 + f.length);
  new DataView(out.buffer).setUint32(0, f.length);
  out.set(f, 4);
  return out;
};
function splitFrames(all: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + 4 <= all.length; ) {
    const n = new DataView(all.buffer, all.byteOffset + at).getUint32(0);
    out.push(all.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}
