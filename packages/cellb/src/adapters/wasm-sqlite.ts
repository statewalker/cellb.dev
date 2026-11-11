import { splitSqlStatements } from "../core/sql-split.js";
import type { OpenCellSql, SqlResult, SyncSqlDriver } from "../ports.js";
import { type DirtyPages, installPageHook } from "./wasm-page-hook.js";
import { type WasmSqlite3, wasmSessionCapture } from "./wasm-session.js";

/** Minimal slice of the @sqlite.org/sqlite-wasm `oo1.DB` API we rely on. */
export interface Oo1Db {
  prepare(sql: string): Oo1Stmt;
  exec(sql: string): unknown;
  changes(): number;
  close(): void;
}
interface Oo1Stmt {
  bind(values: unknown[]): Oo1Stmt;
  getColumnNames(): string[];
  columnCount: number;
  step(): boolean;
  get(target: unknown[]): unknown[];
  finalize(): void;
}

/**
 * SyncSqlDriver over the official SQLite WASM build (oo1 API). Synchronous,
 * so it satisfies `ctx.storage.sql`. Works in Node (in-memory, for tests) and
 * in browsers; persistence comes from the VFS behind the DB (see sahpoolOpener).
 */
/** Backup hooks: how to export an image of the DB and how to replace it (returns the reopened DB). */
export interface WasmImageHooks {
  image(db: Oo1Db): Uint8Array;
  restore(db: Oo1Db, image: Uint8Array): Oo1Db;
}

export class WasmSqliteDriver implements SyncSqlDriver {
  captureStart?: () => void;
  captureTake?: () => Uint8Array;
  captureDiscard?: () => void;
  applyChangeset?: (changeset: Uint8Array) => void;
  captureCoversRowidTables?: boolean;
  #db: Oo1Db;
  readonly #hooks?: WasmImageHooks;
  readonly #sqlite3?: WasmSqlite3;
  readonly #capi?: { sqlite3_get_autocommit(db: number): number };
  #pageHook?: ReturnType<typeof installPageHook>;
  constructor(
    db: Oo1Db,
    hooks?: WasmImageHooks,
    sqlite3?: WasmSqlite3,
    /** SQLite's C API, for `inTransaction()` alone (when `sqlite3` is not given). */
    capi?: { sqlite3_get_autocommit(db: number): number },
  ) {
    this.#db = db;
    this.#hooks = hooks;
    this.#sqlite3 = sqlite3;
    this.#capi = capi ?? sqlite3?.capi;
    if (!this.#capi?.sqlite3_get_autocommit)
      (this as { inTransaction?: unknown }).inTransaction = undefined;
    this.#enableDqs();
    this.#hookPages();
    if (sqlite3?.capi?.sqlite3session_create) {
      // Transaction-log capture (session extension), following the current DB handle.
      Object.assign(
        this,
        wasmSessionCapture(sqlite3, () => (this.#db as unknown as { pointer: number }).pointer),
      );
    }
    if (!hooks) {
      // No image support for this driver: hide the optional port methods.
      (this as { image?: unknown }).image = undefined;
      (this as { restore?: unknown }).restore = undefined;
    }
  }
  image(): Uint8Array {
    return this.#hooks!.image(this.#db);
  }

  /**
   * As celld and workerd: a double-quoted name that is no column is a string literal (SQLite's
   * DQS misfeature, off in this build).
   */
  #enableDqs(): void {
    const capi = this.#sqlite3?.capi;
    if (!capi?.sqlite3_db_config) return;
    const db = (this.#db as unknown as { pointer: number }).pointer;
    capi.sqlite3_db_config(db, capi.SQLITE_DBCONFIG_DQS_DML, 1, 0);
    capi.sqlite3_db_config(db, capi.SQLITE_DBCONFIG_DQS_DDL, 1, 0);
  }

  /** Installs the page hook on the current main database file (see wasm-page-hook.ts). */
  #hookPages(): void {
    this.#pageHook = undefined;
    if (!this.#sqlite3?.capi?.sqlite3_file_control) return;
    try {
      this.#pageHook = installPageHook(
        this.#sqlite3,
        (this.#db as unknown as { pointer: number }).pointer,
      );
    } catch {
      this.#pageHook = undefined;
    }
  }
  /** Pages written since the previous call — a committed transaction's changed pages. */
  takeDirtyPages(): DirtyPages | undefined {
    if (!this.#pageHook) return undefined;
    const pageSize = Number(this.exec("PRAGMA page_size", []).rows[0][0]);
    const pageCount = Number(this.exec("PRAGMA page_count", []).rows[0][0]);
    return this.#pageHook.take(pageSize, pageCount);
  }
  discardDirtyPages(): void {
    this.#pageHook?.discard();
  }
  /**
   * WASM builds cannot load extensions at run time; an extension must be compiled into the
   * build (e.g. the `sqlite-vec-wasm-demo` package for "sqlite_vec"). This only checks it is.
   */
  loadExtension(name: string): void {
    const probe: Record<string, string> = { sqlite_vec: "SELECT vec_version()" };
    if (!probe[name]) throw new Error(`Unknown SQLite extension "${name}"`);
    try {
      this.exec(probe[name], []);
    } catch {
      throw new Error(`SQLite extension "${name}" is not compiled into this SQLite WASM build`);
    }
  }
  restore(image: Uint8Array): void {
    // celld's databases are in WAL mode (header bytes 18–19 = 2); the WASM VFSes (memdb,
    // opfs-sahpool) have no shared memory for WAL and refuse to open such a file. The pages
    // are the same in rollback-journal mode: switch the header to 1 (celld sets WAL again
    // when it opens the database).
    if (image.length > 19 && image[18] === 2 && image[19] === 2) {
      image = image.slice();
      image[18] = 1;
      image[19] = 1;
    }
    this.#db = this.#hooks!.restore(this.#db, image);
    this.#enableDqs();
    this.#hookPages(); // a new database file behind the connection
  }
  exec(sql: string, params: unknown[]): SqlResult {
    const statements = params.length === 0 ? splitSqlStatements(sql) : [sql];
    // Several statements: the result of the last one, with the rows written by all of them.
    let last: SqlResult = { columnNames: [], rows: [], rowsWritten: 0 };
    let written = 0;
    for (const text of statements) {
      last = this.#one(text, params);
      written += last.rowsWritten;
    }
    return { ...last, rowsWritten: written };
  }
  #one(sql: string, params: unknown[]): SqlResult {
    const st = this.#db.prepare(sql);
    try {
      if (params.length) st.bind(params.map(toSqlite));
      const columnNames = st.columnCount ? st.getColumnNames() : [];
      const rows: unknown[][] = [];
      while (st.step()) if (columnNames.length) rows.push(st.get([]).map(fromSqlite));
      return { columnNames, rows, rowsWritten: columnNames.length ? 0 : this.#db.changes() };
    } finally {
      st.finalize();
    }
  }
  inTransaction(): boolean {
    const pointer = (this.#db as unknown as { pointer: number }).pointer;
    return this.#capi!.sqlite3_get_autocommit(pointer) === 0;
  }
  databaseSize(): number {
    const pc = this.exec("PRAGMA page_count", []).rows[0][0];
    const ps = this.exec("PRAGMA page_size", []).rows[0][0];
    return Number(pc) * Number(ps);
  }
  close(): void {
    this.#db.close();
  }
}

function toSqlite(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v === undefined ? null : v;
}
function fromSqlite(v: unknown): unknown {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return v;
}

/** In-memory WASM databases (tests, ephemeral cells). `sqlite3` = await sqlite3InitModule(). */
/** Image hooks for an in-memory DB: `sqlite3_js_db_export` / `sqlite3_deserialize`. */
export function memoryImageHooks(sqlite3: any): WasmImageHooks {
  const { capi, wasm } = sqlite3;
  return {
    image: (db) => sqlite3.capi.sqlite3_js_db_export(db),
    restore(db, image) {
      const p = wasm.allocFromTypedArray(image);
      const rc = capi.sqlite3_deserialize(
        (db as any).pointer,
        "main",
        p,
        image.byteLength,
        image.byteLength,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc) throw new Error(`sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str?.(rc) ?? rc}`);
      return db;
    },
  };
}

/**
 * Sets up a new SQLite WASM connection for a cell. One worker holds many small cells, and SQLite
 * WASM's heap is capped at 2 GiB and never shrinks, so each connection's fixed memory decides how
 * many cells can be open at once:
 * - no lookaside: SQLite's per-connection allocator of small blocks, about 45 KiB each;
 * - 4 KiB pages for a database that is still empty (celld's page size: SQLite's native default;
 *   the WASM build's is 8 KiB). The page cache starts with a block of pages, so the page size
 *   sets most of a connection's memory. A database that already holds data keeps its page size.
 * Together they bring a connection with one small table from about 258 KiB to about 120 KiB.
 */
export function tuneCellConnection(sqlite3: unknown, db: Oo1Db): void {
  const capi = (sqlite3 as { capi?: Record<string, any> }).capi;
  const pointer = (db as unknown as { pointer?: number }).pointer;
  // Before the connection runs any statement: SQLite refuses (SQLITE_BUSY) while lookaside is used.
  if (capi?.sqlite3_db_config && pointer) {
    capi.sqlite3_db_config(pointer, capi.SQLITE_DBCONFIG_LOOKASIDE, 0, 0, 0);
  }
  db.exec("PRAGMA page_size=4096");
}

let memdbCounter = 0;
export function wasmMemoryOpener(sqlite3: {
  oo1: { DB: new (path: string, mode?: string) => Oo1Db };
}): OpenCellSql {
  return () => {
    // memdb (not ":memory:"): an in-memory database that IS a VFS file, so the page hook works.
    const db = new sqlite3.oo1.DB(`file:/cells-mem-${++memdbCounter}?vfs=memdb`, "c");
    tuneCellConnection(sqlite3, db);
    return new WasmSqliteDriver(db, memoryImageHooks(sqlite3), sqlite3 as never);
  };
}

/**
 * Browser persistence: one OPFS "SyncAccessHandle pool" database per cell.
 * Must run in a Dedicated Worker; needs neither COOP/COEP nor SharedArrayBuffer.
 * Not runnable in Node (installOpfsSAHPoolVfs is browser-only) — covered by P04's Playwright spec.
 */
export async function sahpoolOpener(
  sqlite3: {
    installOpfsSAHPoolVfs(opts: { name?: string; initialCapacity?: number }): Promise<{
      OpfsSAHPoolDb: new (path: string) => Oo1Db;
      reserveMinimumCapacity(n: number): Promise<number>;
      addCapacity?(n: number): Promise<number>;
      getCapacity(): number;
      getFileCount(): number;
      getFileNames?(): string[];
      // Not in older SQLite WASM builds (sqlite-vec's): there `release()` does nothing.
      pauseVfs?(): unknown;
      isPaused?(): boolean;
      unpauseVfs?(): Promise<unknown>;
    }>;
  },
  opts: { name?: string; initialCapacity?: number } = {},
): Promise<OpenCellSql & { reserve(n: number): Promise<number>; release(): void }> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: opts.name ?? "cellb",
    initialCapacity: opts.initialCapacity ?? 16,
  });
  // The same pool again in this worker (SQLite WASM keeps one per name), after a `release()`.
  if (pool.isPaused?.()) await pool.unpauseVfs?.();
  // A full pool fails the open (`SAH pool is full`), and opening is synchronous while growing
  // the pool is not. Each new slot is an OPFS file with a sync access handle, made one at a time,
  // and once the worker is busy each one takes seconds (about 5 s with 32 Flue conversations in
  // one worker), so the pool grows ahead of need, in small steps:
  // - a cell about to open reserves room first (`room`, awaited by the runtime before the cell's
  //   first event): its database, its journal and a spare, and it waits until what was needed
  //   when it asked fits, one step of 16 slots at a time (not a doubling, nor later reservations);
  // - an open cell counts its journal until it has one (SQLite makes it at the cell's first
  //   write), so the pool grows while it still has room, not once the journals fill it;
  // - at each open (failed ones too: a cell can reopen without `room`), the pool grows in the
  //   background until two thirds of it are free: an unused slot costs a small file, a missing
  //   one a wait of seconds per slot, so it grows while the worker is still quiet.
  const SLOTS_PER_CELL = 3; // the database, its journal, and one spare
  const STEP = 16; // slots per growth step, made in parallel
  const AHEAD = 3; // the pool's size, in multiples of what it needs, kept by the background growth
  const reserved = new Set<string>();
  const opened = new Map<string, { path: string }>(); // the open cells' databases
  let growing: Promise<void> | undefined;
  /**
   * One growth step toward `target` (one at a time: a second caller joins it). SQLite makes a
   * pool's new slots one after another, two awaited OPFS calls each, and in a busy worker each
   * await waits seconds for the event loop: the step asks for its slots in parallel instead,
   * one `addCapacity(1)` each, so it costs about one slot's wait.
   */
  const step = (target: number): Promise<void> => {
    const n = Math.min(target, pool.getCapacity() + STEP) - pool.getCapacity();
    growing ??= (
      pool.addCapacity && n > 0
        ? Promise.all(Array.from({ length: n }, () => pool.addCapacity?.(1)))
        : pool.reserveMinimumCapacity(pool.getCapacity() + Math.max(n, 0))
    )
      .then(() => {})
      .finally(() => {
        growing = undefined;
      });
    return growing;
  };
  const needed = () => {
    // Journals not made yet. Without the pool's file names (older SQLite WASM builds) none
    // is counted, as before: the files that exist are.
    let journals = 0;
    if (pool.getFileNames) {
      const files = new Set(pool.getFileNames());
      for (const { path } of opened.values()) if (!files.has(`${path}-journal`)) journals++;
    }
    return pool.getFileCount() + journals + SLOTS_PER_CELL * reserved.size;
  };
  /** Grows until `target()` fits; stops when a step of its own adds nothing (the open says why). */
  const growTo = async (target: () => number): Promise<void> => {
    while (target() > pool.getCapacity()) {
      // A step already under way may have added its slots and not ended yet: joining it says
      // nothing about whether the pool can grow.
      const joined = growing !== undefined;
      const before = pool.getCapacity();
      await step(target());
      if (!joined && pool.getCapacity() <= before) return;
    }
  };
  const room = (cellKey: string): Promise<void> | undefined => {
    reserved.add(cellKey);
    const target = needed();
    if (target <= pool.getCapacity()) return undefined;
    return growTo(() => target);
  };
  let ahead: Promise<void> | undefined;
  const keepRoom = () => {
    if (ahead || pool.getCapacity() >= AHEAD * needed()) return;
    ahead = growTo(() => AHEAD * needed())
      .catch(() => {})
      .finally(() => {
        ahead = undefined;
      });
  };
  // The rollback journal stays in the pool between transactions (PERSIST): DELETE gives its pool
  // slot back and takes it again on every commit, which costs a header write each time. The
  // database file is the same in both modes (only WAL marks it).
  const openDb = (path: string) => {
    const db = new pool.OpfsSAHPoolDb(path);
    tuneCellConnection(sqlite3, db);
    db.exec("PRAGMA journal_mode=PERSIST");
    return db;
  };
  const open: OpenCellSql = (cellKey) => {
    const path = `/${cellKey.replace(/[^\w.-]/g, "_")}.sqlite`;
    reserved.delete(cellKey);
    // Counted from now on, with its journal until it has one; no longer once it is closed.
    const entry = { path };
    opened.set(cellKey, entry);
    keepRoom();
    let driver: WasmSqliteDriver;
    try {
      driver = new WasmSqliteDriver(
        openDb(path),
        {
          image: (db) => (sqlite3 as any).capi.sqlite3_js_db_export(db),
          // Replace the file inside the pool, then reopen it.
          restore(db, image) {
            db.close();
            (pool as any).importDb(path, image);
            return openDb(path);
          },
        },
        sqlite3 as never,
      );
    } catch (err) {
      if (opened.get(cellKey) === entry) opened.delete(cellKey);
      throw err;
    }
    const close = driver.close.bind(driver);
    driver.close = () => {
      // Only this driver's entry: the cell may have been opened again since.
      if (opened.get(cellKey) === entry) opened.delete(cellKey);
      close();
    };
    return driver;
  };
  return Object.assign(open, {
    room,
    reserve: (n: number) => pool.reserveMinimumCapacity(n),
    /**
     * Gives the pool's OPFS files back once every database is closed, so that another worker
     * (another tab's) can open the pool at once instead of when this worker is gone.
     */
    release: () => void pool.pauseVfs?.(),
  });
}
