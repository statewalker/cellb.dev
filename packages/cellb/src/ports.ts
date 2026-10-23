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
  /** Loads a named SQLite extension (e.g. "sqlite_vec" for celld's `sqlite_vec` flag). */
  loadExtension?(name: string): void;
  /**
   * Change capture for transaction logs (SQLite session extension): `captureStart()` at
   * BEGIN, `captureTake()` after COMMIT returns the transaction's changeset (empty if none),
   * `applyChangeset()` replays one. `captureCoversRowidTables` is false when tables without
   * a PRIMARY KEY are invisible to the session (node:sqlite has no ROWID session option).
   */
  captureStart?(): void;
  captureTake?(): Uint8Array;
  captureDiscard?(): void;
  applyChangeset?(changeset: Uint8Array): void;
  readonly captureCoversRowidTables?: boolean;
  /** The database file page for page (page-level logs); defaults to snapshot(). */
  pageImage?(): Uint8Array;
  /** Pages written since the previous call, when the driver can hook its file (SQLite WASM). */
  takeDirtyPages?():
    | { pageSize: number; pageCount: number; pages: Map<number, Uint8Array> }
    | undefined;
  discardDirtyPages?(): void;
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
  committed(
    cellKey: string,
    info: {
      seq: number;
      changes?: CommitChanges;
      /** The committed database image (or a thunk producing it on demand). */
      image?: Uint8Array | (() => Uint8Array | undefined | Promise<Uint8Array | undefined>);
      /** The transaction's changed pages, when the driver hooks its file. */
      pages?: { pageSize: number; pageCount: number; pages: Map<number, Uint8Array> };
      epoch?: number;
    },
  ): Promise<void>;
  /**
   * celld's alarm wake index: after a commit that changed the alarm, its publication
   * (writer epoch, sequence, due time) — written once the commit is durable.
   */
  publishWake?(
    cellKey: string,
    wake: { epoch: number; sequence: number; at: number | null },
  ): Promise<void>;
  /** Alarms published in the shared wake index (by any node), so this node can fire them. */
  wakes?(): Promise<{ cellKey: string; className: string; at: number }[]>;
  /** Asks the runtime for the whole database image after each commit (page-level logs: LTX). */
  readonly capturePages?: boolean;
  /** Asks the runtime to capture each transaction's changes (transaction-log durability). */
  readonly captureChanges?: boolean;
}

/**
 * One committed transaction, as a log segment: schema statements, the row changes (a
 * SQLite changeset), and — only for drivers whose capture misses tables without a PRIMARY
 * KEY — the write statements on such tables. `logSeq` is stored in the database itself
 * (`_cf_METADATA`), so a snapshot knows which segments it already contains.
 */
export interface CommitChanges {
  logSeq: number;
  /** Fencing epoch of the owner that committed it (from the cell's lease), if owned. */
  epoch?: number;
  ddl: string[];
  changeset: Uint8Array;
  statements: [string, unknown[]][];
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
  /** Last transaction-log segment contained in the image (0 when no log is kept). */
  logSeq?: number;
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
  /** Transaction-log segments after `afterLogSeq`, in order (replayed after `load`). */
  replay?(cellKey: string, afterLogSeq: number): AsyncIterable<CommitChanges>;
  intervalMs?: number;
  onError?(cellKey: string, error: unknown): void;
}
