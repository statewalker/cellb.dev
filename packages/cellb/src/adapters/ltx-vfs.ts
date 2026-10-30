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
    Atomics.wait(ctl, 0, 0);
    stats.blockedMs += performance.now() - t;
    if (ctl[0] === 2) throw new Error(new TextDecoder().decode(payload.slice(0, ctl[1])));
    return payload.slice(0, ctl[1]);
  };
  const meta = JSON.parse(new TextDecoder().decode(call({ op: "meta" }))) as {
    pageSize: number;
    pageCount: number;
  };
  let pageSize = meta.pageSize || 4096;
  let pageCount = meta.pageCount;
  const cache = new Map<number, Uint8Array>(); // LRU: insertion order
  const dirty = new Map<number, Uint8Array>();
  const page = (pgno: number): Uint8Array => {
    const d = dirty.get(pgno);
    if (d) return d;
    stats.reads++;
    const c = cache.get(pgno);
    if (c) {
      stats.cacheHits++;
      cache.delete(pgno);
      cache.set(pgno, c);
      return c;
    }
    stats.storeReads++;
    if (pgno > pageCount) return new Uint8Array(pageSize);
    const count = Math.min(
      readAhead,
      pageCount - pgno + 1,
      Math.floor((channel.sab.byteLength - 8) / pageSize),
    );
    const run = call({ op: "readRun", pgno, count });
    for (let i = 0; i * pageSize < run.length; i++) {
      const q = pgno + i;
      if (dirty.has(q)) continue;
      cache.set(q, run.subarray(i * pageSize, (i + 1) * pageSize));
      if (cache.size > cacheMax) cache.delete(cache.keys().next().value as number);
    }
    return cache.get(pgno) ?? new Uint8Array(pageSize);
  };

  // Journal and other non-main files: plain memory.
  const memFiles = new Map<string, Uint8Array>();
  const open = new Map<number, { main: boolean; path: string }>();

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
            const size = pageCount * pageSize;
            let o = 0;
            while (o < n && at + o < size) {
              const pos = at + o;
              const pgno = Math.floor(pos / pageSize) + 1;
              const inPage = pos % pageSize;
              const take = Math.min(pageSize - inPage, n - o);
              heap.set(page(pgno).subarray(inPage, inPage + take), pDest + o);
              o += take;
            }
            if (o < n) {
              heap.fill(0, pDest + o, pDest + n);
              return SQLITE_IOERR_SHORT_READ;
            }
            return SQLITE_OK;
          } catch {
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
          if (pageCount === 0 && at === 0 && n >= 18)
            pageSize = ((src[16] << 8) | src[17]) === 1 ? 65536 : (src[16] << 8) | src[17];
          for (let o = 0; o < n; ) {
            const pos = at + o;
            const pgno = Math.floor(pos / pageSize) + 1;
            const inPage = pos % pageSize;
            const take = Math.min(pageSize - inPage, n - o);
            let p = dirty.get(pgno);
            if (!p) {
              p = take === pageSize ? new Uint8Array(pageSize) : page(pgno).slice();
              dirty.set(pgno, p);
            }
            p.set(src.subarray(o, o + take), inPage);
            o += take;
            if (pgno > pageCount) pageCount = pgno;
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
          pageCount = Math.ceil(Number(size) / pageSize);
          for (const k of [...dirty.keys()]) if (k > pageCount) dirty.delete(k);
          return SQLITE_OK;
        },
        xSync(pFile: number) {
          if (!open.get(pFile)?.main || !dirty.size) return SQLITE_OK;
          // The commit: this transaction's pages become one LTX file in the store.
          try {
            const pages = [...dirty].sort((a, b) => a[0] - b[0]);
            call({ op: "commit", pageSize, pageCount, pages });
            stats.commits++;
            for (const [pgno, p] of pages) cache.set(pgno, p);
            dirty.clear();
            return SQLITE_OK;
          } catch {
            return SQLITE_IOERR;
          }
        },
        xFileSize(pFile: number, pOut: number) {
          const f = open.get(pFile);
          const size = f?.main ? pageCount * pageSize : (memFiles.get(f?.path ?? "")?.length ?? 0);
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
          open.set(pFile, { main: !!(flags & SQLITE_OPEN_MAIN_DB), path });
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
