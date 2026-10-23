import { splitSqlStatements } from "../core/sql-split.js";
import type { OpenCellSql, SqlResult, SyncSqlDriver } from "../ports.js";
import { type DirtyPages, installPageHook } from "./wasm-page-hook.js";
import { type WasmSqlite3, wasmSessionCapture } from "./wasm-session.js";

/** Minimal slice of the @sqlite.org/sqlite-wasm `oo1.DB` API we rely on. */
export interface Oo1Db {
  prepare(sql: string): Oo1Stmt;
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
  snapshot(db: Oo1Db): Uint8Array;
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
  #pageHook?: ReturnType<typeof installPageHook>;
  constructor(db: Oo1Db, hooks?: WasmImageHooks, sqlite3?: WasmSqlite3) {
    this.#db = db;
    this.#hooks = hooks;
    this.#sqlite3 = sqlite3;
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
      (this as { snapshot?: unknown }).snapshot = undefined;
      (this as { restore?: unknown }).restore = undefined;
    }
  }
  snapshot(): Uint8Array {
    return this.#hooks!.snapshot(this.#db);
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
    snapshot: (db) => sqlite3.capi.sqlite3_js_db_export(db),
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

let memdbCounter = 0;
export function wasmMemoryOpener(sqlite3: {
  oo1: { DB: new (path: string, mode?: string) => Oo1Db };
}): OpenCellSql {
  return () =>
    new WasmSqliteDriver(
      // memdb (not ":memory:"): an in-memory database that IS a VFS file, so the page hook works.
      new sqlite3.oo1.DB(`file:/cells-mem-${++memdbCounter}?vfs=memdb`, "c"),
      memoryImageHooks(sqlite3),
      sqlite3 as never,
    );
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
    }>;
  },
  opts: { name?: string; initialCapacity?: number } = {},
): Promise<OpenCellSql & { reserve(n: number): Promise<number> }> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: opts.name ?? "webrun-cells",
    initialCapacity: opts.initialCapacity ?? 16,
  });
  const open: OpenCellSql = (cellKey) => {
    const path = `/${cellKey.replace(/[^\w.-]/g, "_")}.sqlite`;
    return new WasmSqliteDriver(
      new pool.OpfsSAHPoolDb(path),
      {
        snapshot: (db) => (sqlite3 as any).capi.sqlite3_js_db_export(db),
        // Replace the file inside the pool, then reopen it.
        restore(db, image) {
          db.close();
          (pool as any).importDb(path, image);
          return new pool.OpfsSAHPoolDb(path);
        },
      },
      sqlite3 as never,
    );
  };
  // Each open DB holds ~2-3 pool slots (db + journal); grow before opening many cells.
  return Object.assign(open, { reserve: (n: number) => pool.reserveMinimumCapacity(n) });
}
