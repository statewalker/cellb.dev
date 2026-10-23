import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";

// Loaded via require: bundlers (vite/vitest) strip the "node:" prefix of the
// still-experimental node:sqlite builtin and fail to resolve "sqlite".
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

import { splitSqlStatements } from "../core/sql-split.js";
import type { OpenCellSql, SqlResult, SyncSqlDriver } from "../ports.js";

const requireCjs = createRequire(import.meta.url);
const KNOWN_EXTENSIONS: Record<string, () => string> = {
  sqlite_vec: () => (requireCjs("sqlite-vec") as { getLoadablePath(): string }).getLoadablePath(),
};

/** Server-side SyncSqlDriver over node:sqlite (Node >= 22.13). */
export class NodeSqliteDriver implements SyncSqlDriver {
  #db: DatabaseSyncT;
  #path: string;
  readonly #exclusive: boolean;
  constructor(path = ":memory:", opts: { exclusive?: boolean } = {}) {
    this.#path = path;
    this.#exclusive = !!opts.exclusive;
    // As celld and workerd: a double-quoted name that is no column is a string literal.
    this.#db = new DatabaseSync(path, {
      allowExtension: true,
      enableDoubleQuotedStringLiterals: true,
    });
    this.#db.enableLoadExtension(false); // only loadExtension() below may load, by name
    // EXCLUSIVE locking: the first write takes an OS lock on the file that is
    // kept until close (or process death) — a second process can neither read
    // nor write the cell. Storage-level fencing on one host, no lease needed.
    if (opts.exclusive) this.#db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0;");
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
    const stmt = this.#db.prepare(sql);
    const columnNames = stmt.columns().map((c) => c.name);
    const args = params.map(toSqlite) as any[];
    if (columnNames.length === 0) {
      const r = stmt.run(...args);
      return { columnNames, rows: [], rowsWritten: Number(r.changes) };
    }
    stmt.setReturnArrays(true);
    const rows = (stmt.all(...args) as unknown as unknown[][]).map((row) => row.map(fromSqlite));
    return { columnNames, rows, rowsWritten: 0 };
  }
  databaseSize(): number {
    const [pc] = this.exec("PRAGMA page_count", []).rows[0] as [number];
    const [ps] = this.exec("PRAGMA page_size", []).rows[0] as [number];
    return Number(pc) * Number(ps);
  }
  close(): void {
    this.#db.close();
  }

  // ---- change capture (session extension) for transaction logs -------------------------
  #session: { changeset(): Uint8Array; close(): void } | undefined;
  /** node:sqlite exposes no ROWID session option: PK-less tables are logged as statements. */
  readonly captureCoversRowidTables = false;
  captureStart(): void {
    this.#session?.close();
    this.#session = (
      this.#db as unknown as { createSession(): { changeset(): Uint8Array; close(): void } }
    ).createSession();
  }
  captureTake(): Uint8Array {
    const s = this.#session;
    this.#session = undefined;
    if (!s) return new Uint8Array();
    try {
      return s.changeset();
    } finally {
      s.close();
    }
  }
  captureDiscard(): void {
    this.#session?.close();
    this.#session = undefined;
  }
  applyChangeset(changeset: Uint8Array): void {
    if (!changeset.byteLength) return;
    const SQLITE_CHANGESET_REPLACE = 1;
    (this.#db as unknown as { applyChangeset(c: Uint8Array, o: unknown): boolean }).applyChangeset(
      changeset,
      {
        onConflict: () => SQLITE_CHANGESET_REPLACE,
      },
    );
  }

  /** Known extensions only: "sqlite_vec" → the sqlite-vec npm package's loadable library. */
  loadExtension(name: string): void {
    const path = KNOWN_EXTENSIONS[name]?.();
    if (!path) throw new Error(`Unknown SQLite extension "${name}"`);
    this.#db.enableLoadExtension(true);
    try {
      this.#db.loadExtension(path);
    } finally {
      this.#db.enableLoadExtension(false);
    }
  }

  /**
   * The database file as SQLite wrote it (page for page), for page-level logs; an in-memory
   * database falls back to snapshot(). Valid between transactions (rollback journal mode).
   */
  pageImage(): Uint8Array {
    if (this.#path === ":memory:") return this.snapshot();
    // A database restored from celld's files is in WAL mode (litestream needs it): its last
    // commits are in the -wal file until a checkpoint moves them into the main file.
    const mode = String(this.#db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "");
    if (mode.toLowerCase() === "wal") this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return new Uint8Array(readFileSync(this.#path));
  }

  /** `VACUUM INTO` a temp file: a consistent, compact image (no open transaction allowed). */
  snapshot(): Uint8Array {
    const tmp = join(mkdtempSync(join(tmpdir(), "cell-snap-")), "db.sqlite");
    try {
      this.#db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return new Uint8Array(readFileSync(tmp));
    } finally {
      rmSync(dirname(tmp), { recursive: true, force: true });
    }
  }

  /** Replaces the database file with `image` and reopens it (an in-memory DB becomes file-backed). */
  restore(image: Uint8Array): void {
    this.#db.close();
    if (this.#path === ":memory:")
      this.#path = join(mkdtempSync(join(tmpdir(), "cell-mem-")), "db.sqlite");
    for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(this.#path + suffix, { force: true });
    writeFileSync(this.#path, image);
    this.#db = new DatabaseSync(this.#path, { enableDoubleQuotedStringLiterals: true });
    if (this.#exclusive) this.#db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0;");
  }
}

function toSqlite(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v === undefined ? null : v;
}
/** Workers return BLOBs as ArrayBuffer. */
function fromSqlite(v: unknown): unknown {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return v;
}

/** One file per cell in `dir`, or in-memory when `dir` is omitted. */
export function nodeSqliteOpener(dir?: string, opts: { exclusive?: boolean } = {}): OpenCellSql {
  return (cellKey) =>
    new NodeSqliteDriver(
      dir ? `${dir}/${cellKey.replace(/[^\w.-]/g, "_")}.sqlite` : ":memory:",
      opts,
    );
}
