/**
 * A synchronous SQLite VFS (SQLite WASM, in a worker) over an ASYNCHRONOUS page store in another
 * thread: the database is a cell's LTX files on a FilesApi (src/ltx/ltx-pages.ts, served by
 * ltxPageServer). Reads block on a SharedArrayBuffer (Atomics.wait) while the store reads the
 * page by range; pages are cached here (LRU). Writes stay in this worker until the commit
 * (xSync of the main file), which sends the transaction's pages to the store: one LTX file.
 * The rollback journal lives in memory (journal_mode=MEMORY): only the main file is a file.
 *
 * Needs cross-origin isolation (SharedArrayBuffer). One writer per database.
 */
const SQLITE_OK = 0;
const SQLITE_IOERR = 10;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_OPEN_MAIN_DB = 0x100;

export interface LtxVfsChannel {
  /** Shared control words [state, length] + payload (≥ one page). */
  sab: SharedArrayBuffer;
  /** Posts a request to the store (it answers into `sab`, then notifies). */
  post(msg: unknown): void;
}

export interface LtxVfsStats {
  reads: number;
  cacheHits: number;
  storeReads: number;
  commits: number;
  blockedMs: number;
}

export function installLtxVfs(
  sqlite3: any,
  channel: LtxVfsChannel,
  opts: { name?: string; cachePages?: number; readAhead?: number } = {},
): { name: string; stats: LtxVfsStats } {
  const { capi, wasm } = sqlite3;
  const name = opts.name ?? "ltx";
  const cacheMax = opts.cachePages ?? 2048;
  // A miss fetches this many consecutive pages at once (SQLite scans walk pages in order).
  const readAhead = Math.max(1, opts.readAhead ?? 16);
  const ctl = new Int32Array(channel.sab, 0, 2);
  const payload = new Uint8Array(channel.sab, 8);
  const stats: LtxVfsStats = { reads: 0, cacheHits: 0, storeReads: 0, commits: 0, blockedMs: 0 };

  /** A request answered synchronously: blocks this worker until the store notifies. */
  const call = (msg: Record<string, unknown>): Uint8Array => {
    Atomics.store(ctl, 0, 0);
    const t = performance.now();
    channel.post(msg);
    // A store that never answers (a worker that failed to load) must not freeze this worker.
    if (Atomics.wait(ctl, 0, 0, 30_000) === "timed-out")
      throw new Error(`ltx store: no answer to ${String(msg.op)} in 30 s`);
    stats.blockedMs += performance.now() - t;
    if (ctl[0] === 2) throw new Error(new TextDecoder().decode(payload.slice(0, ctl[1])));
    return payload.slice(0, ctl[1]);
  };
  /** One open database (a cell): its size, its page cache, the current transaction's pages. */
  interface Db {
    cell: string;
    pageSize: number;
    pageCount: number;
    cache: Map<number, Uint8Array>; // LRU: insertion order
    dirty: Map<number, Uint8Array>;
  }
  const dbs = new Map<string, Db>();
  const dbOf = (cell: string): Db => {
    let d = dbs.get(cell);
    if (!d) {
      const meta = JSON.parse(new TextDecoder().decode(call({ op: "meta", cell }))) as {
        pageSize: number;
        pageCount: number;
      };
      d = {
        cell,
        pageSize: meta.pageSize || 4096,
        pageCount: meta.pageCount,
        cache: new Map(),
        dirty: new Map(),
      };
      dbs.set(cell, d);
    }
    return d;
  };
  const page = (d: Db, pgno: number): Uint8Array => {
    const w = d.dirty.get(pgno);
    if (w) return w;
    stats.reads++;
    const c = d.cache.get(pgno);
    if (c) {
      stats.cacheHits++;
      d.cache.delete(pgno);
      d.cache.set(pgno, c);
      return c;
    }
    stats.storeReads++;
    if (pgno > d.pageCount) return new Uint8Array(d.pageSize);
    const count = Math.min(
      readAhead,
      d.pageCount - pgno + 1,
      Math.floor((channel.sab.byteLength - 8) / d.pageSize),
    );
    const run = call({ op: "readRun", cell: d.cell, pgno, count });
    for (let i = 0; i * d.pageSize < run.length; i++) {
      const q = pgno + i;
      if (d.dirty.has(q)) continue;
      d.cache.set(q, run.subarray(i * d.pageSize, (i + 1) * d.pageSize));
      if (d.cache.size > cacheMax) d.cache.delete(d.cache.keys().next().value as number);
    }
    return d.cache.get(pgno) ?? new Uint8Array(d.pageSize);
  };

  // Journal and other non-main files: plain memory.
  const memFiles = new Map<string, Uint8Array>();
  const open = new Map<number, { main: boolean; path: string; db?: Db }>();

  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 1;
  const vfs = new capi.sqlite3_vfs();
  vfs.$iVersion = 1;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfs.$mxPathname = 512;

  sqlite3.vfs.installVfs({
    io: {
      struct: io,
      methods: {
        xClose(pFile: number) {
          const d = open.get(pFile)?.db;
          if (d) dbs.delete(d.cell); // its cache goes with it
          open.delete(pFile);
          return SQLITE_OK;
        },
        xRead(pFile: number, pDest: number, n: number, off: bigint) {
          const f = open.get(pFile);
          const at = Number(off);
          const heap = wasm.heap8u();
          if (!f?.main) {
            const b = memFiles.get(f?.path ?? "") ?? new Uint8Array();
            const got = b.subarray(at, at + n);
            heap.set(got, pDest);
            if (got.length < n) {
              heap.fill(0, pDest + got.length, pDest + n);
              return SQLITE_IOERR_SHORT_READ;
            }
            return SQLITE_OK;
          }
          try {
            const d = f.db as Db;
            const { pageSize } = d;
            const size = d.pageCount * pageSize;
            let o = 0;
            while (o < n && at + o < size) {
              const pos = at + o;
              const pgno = Math.floor(pos / pageSize) + 1;
              const inPage = pos % pageSize;
              const take = Math.min(pageSize - inPage, n - o);
              heap.set(page(d, pgno).subarray(inPage, inPage + take), pDest + o);
              o += take;
            }
            if (o < n) {
              heap.fill(0, pDest + o, pDest + n);
              return SQLITE_IOERR_SHORT_READ;
            }
            return SQLITE_OK;
          } catch (err) {
            // SQLite only sees SQLITE_IOERR (and rolls the transaction back): say why.
            console.error(`cellb ltx-vfs: ${(err as Error)?.message ?? err}`);
            return SQLITE_IOERR;
          }
        },
        xWrite(pFile: number, pSrc: number, n: number, off: bigint) {
          const f = open.get(pFile);
          const at = Number(off);
          const src = wasm.heap8u().subarray(pSrc, pSrc + n);
          if (!f?.main) {
            const cur = memFiles.get(f?.path ?? "") ?? new Uint8Array();
            const next = cur.length >= at + n ? cur : new Uint8Array(at + n);
            if (next !== cur) next.set(cur);
            next.set(src, at);
            memFiles.set(f?.path ?? "", next);
            return SQLITE_OK;
          }
          const d = f.db as Db;
          if (d.pageCount === 0 && at === 0 && n >= 18) {
            const ps = (src[16] << 8) | src[17];
            d.pageSize = ps === 1 ? 65536 : ps;
          }
          const { pageSize } = d;
          for (let o = 0; o < n; ) {
            const pos = at + o;
            const pgno = Math.floor(pos / pageSize) + 1;
            const inPage = pos % pageSize;
            const take = Math.min(pageSize - inPage, n - o);
            let p = d.dirty.get(pgno);
            if (!p) {
              p = take === pageSize ? new Uint8Array(pageSize) : page(d, pgno).slice();
              d.dirty.set(pgno, p);
            }
            p.set(src.subarray(o, o + take), inPage);
            o += take;
            if (pgno > d.pageCount) d.pageCount = pgno;
          }
          return SQLITE_OK;
        },
        xTruncate(pFile: number, size: bigint) {
          const f = open.get(pFile);
          if (!f?.main) {
            memFiles.set(
              f?.path ?? "",
              (memFiles.get(f?.path ?? "") ?? new Uint8Array()).slice(0, Number(size)),
            );
            return SQLITE_OK;
          }
          const d = f.db as Db;
          d.pageCount = Math.ceil(Number(size) / d.pageSize);
          for (const k of [...d.dirty.keys()]) if (k > d.pageCount) d.dirty.delete(k);
          return SQLITE_OK;
        },
        xSync(pFile: number) {
          const d = open.get(pFile)?.db;
          if (!d || !d.dirty.size) return SQLITE_OK;
          // The commit: this transaction's pages become one LTX file in the store.
          try {
            const pages = [...d.dirty].sort((a, b) => a[0] - b[0]);
            call({
              op: "commit",
              cell: d.cell,
              pageSize: d.pageSize,
              pageCount: d.pageCount,
              pages,
            });
            stats.commits++;
            for (const [pgno, p] of pages) d.cache.set(pgno, p);
            d.dirty.clear();
            return SQLITE_OK;
          } catch (err) {
            // SQLite only sees SQLITE_IOERR (and rolls the transaction back): say why.
            console.error(`cellb ltx-vfs: ${(err as Error)?.message ?? err}`);
            return SQLITE_IOERR;
          }
        },
        xFileSize(pFile: number, pOut: number) {
          const f = open.get(pFile);
          const size = f?.db
            ? f.db.pageCount * f.db.pageSize
            : (memFiles.get(f?.path ?? "")?.length ?? 0);
          wasm.poke64(pOut, BigInt(size));
          return SQLITE_OK;
        },
        xLock: () => SQLITE_OK,
        xUnlock: () => SQLITE_OK,
        xCheckReservedLock(_p: number, pOut: number) {
          wasm.poke32(pOut, 0);
          return SQLITE_OK;
        },
        xFileControl: () => 12, // SQLITE_NOTFOUND
        xSectorSize: () => 4096,
        xDeviceCharacteristics: () => 0,
      },
    },
    vfs: {
      struct: vfs,
      name,
      methods: {
        xOpen(_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) {
          const path = zName ? wasm.cstrToJs(zName) : `tmp-${pFile}`;
          const main = !!(flags & SQLITE_OPEN_MAIN_DB);
          try {
            open.set(pFile, { main, path, db: main ? dbOf(path) : undefined });
          } catch (err) {
            // SQLite only sees SQLITE_IOERR (and rolls the transaction back): say why.
            console.error(`cellb ltx-vfs: ${(err as Error)?.message ?? err}`);
            return SQLITE_IOERR;
          }
          const f = new capi.sqlite3_file(pFile);
          f.$pMethods = io.pointer;
          f.dispose();
          if (pOutFlags) wasm.poke32(pOutFlags, flags);
          return SQLITE_OK;
        },
        xDelete(_p: number, zName: number) {
          memFiles.delete(wasm.cstrToJs(zName));
          return SQLITE_OK;
        },
        xAccess(_p: number, zName: number, _flags: number, pOut: number) {
          wasm.poke32(pOut, memFiles.has(wasm.cstrToJs(zName)) ? 1 : 0);
          return SQLITE_OK;
        },
        xFullPathname(_p: number, zName: number, nOut: number, pOut: number) {
          wasm.cstrncpy(pOut, zName, nOut);
          return SQLITE_OK;
        },
        xRandomness(_p: number, n: number, pOut: number) {
          crypto.getRandomValues(wasm.heap8u().subarray(pOut, pOut + n));
          return n;
        },
        xSleep: () => SQLITE_OK,
        xCurrentTime(_p: number, pOut: number) {
          wasm.poke64f(pOut, 2440587.5 + Date.now() / 86400000);
          return SQLITE_OK;
        },
        xCurrentTimeInt64(_p: number, pOut: number) {
          wasm.poke64(pOut, BigInt(Math.floor(2440587.5 * 86400000 + Date.now())));
          return SQLITE_OK;
        },
        xGetLastError: () => 0,
      },
    },
  });
  return { name, stats };
}
