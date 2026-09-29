/**
 * Ports: the only things that differ between browser and server hosts.
 * Everything in `core/` depends on these interfaces and nothing else.
 */

/** Result of one SQL statement, in array-of-arrays form (cheap to copy across ports). */
export interface SqlResult {
  columnNames: string[];
  rows: unknown[][];
  rowsWritten: number;
}

/**
 * SYNCHRONOUS SQLite driver, one per cell.
 * Browser: SQLite WASM + opfs-sahpool VFS inside a dedicated Worker (P04).
 * Server: node:sqlite DatabaseSync / better-sqlite3 / bun:sqlite.
 */
export interface SyncSqlDriver {
  /** Executes one statement (or a param-less script, returning the last statement's result). */
  exec(sql: string, params: unknown[]): SqlResult;
  /** Size of the database in bytes (ctx.storage.sql.databaseSize). */
  databaseSize(): number;
  close(): void;
  /** Consistent image of the whole database (no transaction may be open). Needed for backups. */
  snapshot?(): Uint8Array;
  /** Replaces the whole database with an image produced by `snapshot()`. Needed for restores. */
  restore?(image: Uint8Array): void;
}

/** Opens (or creates) the SQLite database of a cell. */
export type OpenCellSql = (cellKey: string) => SyncSqlDriver;

/**
 * Durability port: called after every local commit. The output gate holds
 * outgoing responses until the returned promise resolves. P06 plugs
 * replication to a FilesApi (OPFS / S3) here; the default resolves at once.
 */
export interface CellDurability {
  committed(cellKey: string, info: { seq: number }): Promise<void>;
}

/** Serialization of KV values (CF uses V8 serialization; swap for webrun-msgpack later). */
export interface ValueCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface BackupInfo {
  /** Local commit counter of the cell at snapshot time (monotonic per live instance). */
  seq: number;
  takenAt: number;
  reason: "interval" | "manual" | "close";
}

/**
 * Durability by periodic backup: `save` receives a consistent SQLite image of a
 * cell whenever it changed since the last successful save (every `intervalMs`,
 * on `runtime.backupNow()` and on `runtime.close()`). `load` restores a cell
 * whose local database is empty. RPO = interval: writes after the last
 * successful save can be lost with the local store (e.g. an evicted OPFS).
 */
export interface CellBackup {
  save(cellKey: string, image: Uint8Array, info: BackupInfo): Promise<void>;
  load?(cellKey: string): Promise<Uint8Array | undefined>;
  intervalMs?: number;
  onError?(cellKey: string, error: unknown): void;
}
