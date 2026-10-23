import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  readonly #pageCapture: boolean;
  constructor(path = ":memory:", opts: { exclusive?: boolean; pageCapture?: boolean } = {}) {
    this.#path = path;
    this.#exclusive = !!opts.exclusive;
    this.#pageCapture = !!opts.pageCapture && path !== ":memory:";
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
    this.#walSetup();
  }

  // ---- page capture through the WAL (what the WASM driver does with its xWrite hook) ----
  // In WAL mode every commit appends its changed pages to `<db>-wal` as frames (24-byte frame
  // header + page; a commit frame carries the database size in pages). Reading the frames
  // appended since the last read gives exactly the committed transaction's pages, O(changed),
  // instead of reading the whole file. Automatic checkpoints are off; take() checkpoints
  // (TRUNCATE) itself once the WAL grows, and restarts from its start.
  #walOffset = 0;
  #walSetup(): void {
    if (!this.#pageCapture) return;
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#walOffset = 0;
  }
  /** The pages of the transactions committed since the previous call (WAL frames). */
  takeDirtyPages():
    | { pageSize: number; pageCount: number; pages: Map<number, Uint8Array> }
    | undefined {
    if (!this.#pageCapture) return undefined;
    const walPath = `${this.#path}-wal`;
    let fd: number;
    try {
      fd = openSync(walPath, "r");
    } catch {
      return undefined;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < 32) return undefined;
      const header = Buffer.alloc(32);
      readSync(fd, header, 0, 32, 0);
      const pageSize = header.readUInt32BE(8) === 1 ? 65536 : header.readUInt32BE(8);
      const [salt1, salt2] = [header.readUInt32BE(16), header.readUInt32BE(20)];
      const frameSize = 24 + pageSize;
      let offset = Math.max(32, this.#walOffset);
      const pending = new Map<number, Uint8Array>();
      const pages = new Map<number, Uint8Array>();
      let pageCount = 0;
      let committedTo = offset;
      const frame = Buffer.alloc(frameSize);
      while (offset + frameSize <= size) {
        readSync(fd, frame, 0, frameSize, offset);
        if (frame.readUInt32BE(8) !== salt1 || frame.readUInt32BE(12) !== salt2) break; // stale frames
        pending.set(frame.readUInt32BE(0), new Uint8Array(frame.subarray(24)));
        offset += frameSize;
        const commit = frame.readUInt32BE(4);
        if (commit) {
          for (const [p, d] of pending) pages.set(p, d);
          pending.clear();
          pageCount = commit;
          committedTo = offset;
        }
      }
      this.#walOffset = committedTo;
      if (!pageCount)
        return {
          pageSize,
          pageCount: Number(this.exec("PRAGMA page_count", []).rows[0][0]),
          pages,
        };
      for (const p of [...pages.keys()]) if (p > pageCount) pages.delete(p);
      // keep the WAL bounded: fold it into the database and start over
      if (committedTo > 4 * 1024 * 1024) {
        this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.#walOffset = 0;
      }
      return { pageSize, pageCount, pages };
    } finally {
      closeSync(fd);
    }
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
    if (mode.toLowerCase() === "wal") {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.#walOffset = 0; // the WAL starts over
    }
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
    this.#walSetup(); // a new file: a new WAL
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
/**
 * `pageCapture` (file-backed only): WAL mode, and each commit's changed pages read from the WAL
 * (takeDirtyPages) — LTX logs then cost O(changed pages) on Node as with SQLite WASM.
 */
export function nodeSqliteOpener(
  dir?: string,
  opts: { exclusive?: boolean; pageCapture?: boolean } = {},
): OpenCellSql {
  return (cellKey) =>
    new NodeSqliteDriver(
      dir ? `${dir}/${cellKey.replace(/[^\w.-]/g, "_")}.sqlite` : ":memory:",
      opts,
    );
}
