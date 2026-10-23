/**
 * The page hook for SQLite WASM: wraps the io methods of a connection's MAIN database file
 * (whatever VFS opened it — opfs-sahpool in browsers, memdb, unix) so every page SQLite
 * writes is recorded. After a commit the recorded pages ARE the transaction's changed pages:
 * an LTX file costs O(changed pages) instead of a whole-database image.
 *
 * How: SQLITE_FCNTL_FILE_POINTER gives the sqlite3_file; a copy of its sqlite3_io_methods
 * gets a JS xWrite (wasm.installFunction, signature "i(ppij)") that records (offset → bytes)
 * and calls the original xWrite (wasm.functionEntry); the file's pMethods then points to the
 * copy. No new VFS is registered. A connection whose main database has no file (":memory:")
 * cannot be hooked: callers fall back to images.
 */
export interface DirtyPages {
  pageSize: number;
  pageCount: number;
  pages: Map<number, Uint8Array>;
}

export function installPageHook(sqlite3: { capi: any; wasm: any }, dbPointer: number) {
  const { capi, wasm } = sqlite3;
  const stack = wasm.pstack.pointer;
  let pFile = 0;
  try {
    const pp = wasm.pstack.allocPtr();
    if (capi.sqlite3_file_control(dbPointer, "main", capi.SQLITE_FCNTL_FILE_POINTER, pp) !== 0)
      return undefined;
    pFile = wasm.peekPtr(pp);
  } finally {
    wasm.pstack.restore(stack);
  }
  if (!pFile) return undefined;
  const file = new capi.sqlite3_file(pFile);
  if (!file.$pMethods) return undefined; // no real file behind the database
  const orig = new capi.sqlite3_io_methods(file.$pMethods);
  const mine = new capi.sqlite3_io_methods();
  for (const m of Object.keys(capi.sqlite3_io_methods.structInfo.members))
    mine[`$${m}`] = orig[`$${m}`];
  const xWrite = wasm.functionEntry(orig.$xWrite);
  const written = new Map<number, Uint8Array>(); // byte offset → last bytes written there
  const fnPtr = wasm.installFunction(
    "i(ppij)",
    (pF: number, pBuf: number, iAmt: number, iOfst: bigint) => {
      if (pF === pFile) written.set(Number(iOfst), wasm.heap8u().slice(pBuf, pBuf + iAmt));
      return xWrite(pF, pBuf, iAmt, iOfst);
    },
  );
  mine.$xWrite = fnPtr;
  file.$pMethods = mine.pointer;
  return {
    /** The pages written since the last call (whole pages: SQLite writes the main file page by page). */
    take(pageSize: number, pageCount: number): DirtyPages {
      const pages = new Map<number, Uint8Array>();
      for (const [offset, bytes] of written)
        for (let o = 0; o + pageSize <= bytes.length; o += pageSize) {
          const pgno = (offset + o) / pageSize + 1;
          if (Number.isInteger(pgno) && pgno <= pageCount)
            pages.set(pgno, bytes.subarray(o, o + pageSize));
        }
      written.clear();
      return { pageSize, pageCount, pages };
    },
    discard(): void {
      written.clear();
    },
    uninstall(): void {
      file.$pMethods = orig.pointer;
      wasm.uninstallFunction(fnPtr);
      mine.dispose();
    },
  };
}
