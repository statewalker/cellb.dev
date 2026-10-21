import type { ValueCodec } from "../ports.js";
import type { InputGate } from "./gates.js";
import type { SqlStorage } from "./sql-storage.js";

export interface ListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
}

const MAX_KEYS = 128;

/** Synchronous KV API of SQLite-backed objects (`ctx.storage.kv`), stored in `_cf_KV`. */
export class SyncKvStorage {
  #sql: SqlStorage;
  #codec: ValueCodec;
  #ready = false;

  constructor(sql: SqlStorage, codec: ValueCodec) {
    this.#sql = sql;
    this.#codec = codec;
  }
  #init(): void {
    if (this.#ready) return;
    this.#sql.internalExec(
      "CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID",
    );
    this.#ready = true;
  }
  get<T = unknown>(key: string): T | undefined {
    this.#init();
    const r = this.#sql.internalExec("SELECT value FROM _cf_KV WHERE key = ?", [key]);
    if (!r.rows.length) return undefined;
    return this.#codec.decode(new Uint8Array(r.rows[0][0] as ArrayBuffer)) as T;
  }
  put(key: string, value: unknown): void {
    this.#init();
    if (value === undefined) throw new TypeError("Cannot store undefined; use delete()");
    this.#sql.internalExec("INSERT OR REPLACE INTO _cf_KV (key, value) VALUES (?, ?)", [
      key,
      this.#codec.encode(value),
    ]);
  }
  delete(key: string): boolean {
    this.#init();
    return this.#sql.internalExec("DELETE FROM _cf_KV WHERE key = ?", [key]).rowsWritten > 0;
  }
  *list<T = unknown>(opts: ListOptions = {}): IterableIterator<[string, T]> {
    this.#init();
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.start !== undefined) where.push("key >= ?"), params.push(opts.start);
    if (opts.startAfter !== undefined) where.push("key > ?"), params.push(opts.startAfter);
    if (opts.end !== undefined) where.push("key < ?"), params.push(opts.end);
    if (opts.prefix !== undefined)
      where.push("substr(key, 1, ?) = ?"), params.push(opts.prefix.length, opts.prefix);
    let q = "SELECT key, value FROM _cf_KV";
    if (where.length) q += ` WHERE ${where.join(" AND ")}`;
    q += ` ORDER BY key ${opts.reverse ? "DESC" : "ASC"}`;
    if (opts.limit !== undefined) (q += " LIMIT ?"), params.push(opts.limit);
    for (const [k, v] of this.#sql.internalExec(q, params).rows)
      yield [k as string, this.#codec.decode(new Uint8Array(v as ArrayBuffer)) as T];
  }
  deleteAll(): void {
    this.#init();
    this.#sql.internalExec("DELETE FROM _cf_KV");
  }
}

/** Methods shared by `ctx.storage` and the `txn` object of `transaction()`. */
export class AsyncKvApi {
  protected kv: SyncKvStorage;
  protected gate: InputGate;
  constructor(kv: SyncKvStorage, gate: InputGate) {
    this.kv = kv;
    this.gate = gate;
  }
  /** Every async storage op closes the input gate until it (and its continuation) completes. */
  protected op<T>(fn: () => T): Promise<T> {
    return this.gate.runClosed(async () => {
      await Promise.resolve();
      return fn();
    });
  }
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  get(keyOrKeys: string | string[]): Promise<unknown> {
    return this.op(() => {
      if (!Array.isArray(keyOrKeys)) return this.kv.get(keyOrKeys);
      checkKeys(keyOrKeys);
      const m = new Map<string, unknown>();
      for (const k of [...keyOrKeys].sort()) {
        const v = this.kv.get(k);
        if (v !== undefined) m.set(k, v);
      }
      return m;
    });
  }
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    return this.op(() => {
      if (typeof keyOrEntries === "string") return this.kv.put(keyOrEntries, value);
      const entries = Object.entries(keyOrEntries);
      checkKeys(entries.map(([k]) => k));
      for (const [k, v] of entries) this.kv.put(k, v);
    });
  }
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    return this.op(() => {
      if (!Array.isArray(keyOrKeys)) return this.kv.delete(keyOrKeys);
      checkKeys(keyOrKeys);
      return keyOrKeys.filter((k) => this.kv.delete(k)).length;
    });
  }
  list<T = unknown>(opts?: ListOptions): Promise<Map<string, T>> {
    return this.op(() => new Map(this.kv.list<T>(opts)));
  }
}

function checkKeys(keys: string[]): void {
  if (keys.length > MAX_KEYS) throw new RangeError(`Maximum number of keys is ${MAX_KEYS}`);
}

export class DurableObjectTransaction extends AsyncKvApi {
  rolledBack = false;
  rollback(): void {
    this.rolledBack = true;
  }
}

/** `ctx.storage` of a SQLite-backed Durable Object. */
export class DurableObjectStorage extends AsyncKvApi {
  readonly sql: SqlStorage;
  readonly kv: SyncKvStorage;
  #sync: () => Promise<void>;

  constructor(sql: SqlStorage, kv: SyncKvStorage, gate: InputGate, sync: () => Promise<void>) {
    super(kv, gate);
    this.sql = sql;
    this.kv = kv;
    this.#sync = sync;
  }
  deleteAll(): Promise<void> {
    return this.op(() => {
      this.kv.deleteAll();
      this.clearAlarmSync(); // deleteAll() also deletes the alarm, as on Cloudflare
      const tables = this.sql.internalExec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      ).rows;
      for (const [name] of tables)
        this.sql.internalExec(`DROP TABLE IF EXISTS "${String(name).replace(/"/g, '""')}"`);
    });
  }
  transactionSync<T>(fn: () => T): T {
    return this.sql.transactionSync(fn);
  }
  /**
   * Async transaction spanning awaits: the input gate stays closed (no other
   * event can interleave writes into the savepoint) and auto-commit is held.
   */
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return this.gate.runClosed(async () => {
      const release = this.sql.hold();
      const sp = "_cf_atx";
      this.sql.internalExec(`SAVEPOINT ${sp}`);
      const txn = new DurableObjectTransaction(this.kv, this.gate);
      try {
        const r = await closure(txn);
        this.sql.internalExec(txn.rolledBack ? `ROLLBACK TO ${sp}` : `RELEASE ${sp}`);
        if (txn.rolledBack) this.sql.internalExec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.sql.internalExec(`ROLLBACK TO ${sp}`);
        this.sql.internalExec(`RELEASE ${sp}`);
        throw e;
      } finally {
        release();
      }
    });
  }
  /** Resolves once all writes so far are durable (the output gate barrier). */
  #bookmarks = 0;
  /**
   * Point-in-time-recovery bookmarks (workerd API). Bookmarks are opaque, ordered
   * strings; webrun-cells has no PITR yet, so they only identify "now" — enough for
   * D1 sessions (Miniflare's D1 simulator returns them as commit tokens).
   */
  async getCurrentBookmark(): Promise<string> {
    return `${Date.now().toString(16).padStart(12, "0")}-${(++this.#bookmarks).toString(16).padStart(8, "0")}`;
  }
  async getBookmarkForTime(time: number | Date): Promise<string> {
    return `${new Date(time).getTime().toString(16).padStart(12, "0")}-00000000`;
  }
  async onNextSessionRestoreBookmark(_bookmark: string): Promise<string> {
    throw new Error("Point-in-time recovery is not supported by webrun-cells yet");
  }

  sync(): Promise<void> {
    return this.#sync();
  }
  /** Called whenever the stored alarm changes (the runtime schedules it). */
  onAlarmChange: (at: number | null) => void = () => {};

  #metaReady = false;
  #meta(): void {
    if (this.#metaReady) return;
    this.sql.internalExec("CREATE TABLE IF NOT EXISTS _cf_METADATA (key TEXT PRIMARY KEY, value)");
    this.#metaReady = true;
  }
  /** Synchronous read of the stored alarm (ms since epoch) or null. */
  alarmSync(): number | null {
    this.#meta();
    const row = this.sql.internalExec("SELECT value FROM _cf_METADATA WHERE key = 'alarm'").rows[0];
    return row ? Number(row[0]) : null;
  }
  /** One alarm per object, stored in _cf_METADATA (same transaction as the event's writes). */
  getAlarm(_opts?: unknown): Promise<number | null> {
    return this.op(() => this.alarmSync());
  }
  setAlarm(scheduledTime: number | Date, _opts?: unknown): Promise<void> {
    const at = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    if (!Number.isFinite(at))
      return Promise.reject(new TypeError("setAlarm() requires a finite time"));
    return this.op(() => {
      this.#meta();
      this.sql.internalExec(
        "INSERT OR REPLACE INTO _cf_METADATA (key, value) VALUES ('alarm', ?)",
        [at],
      );
      this.onAlarmChange(at);
    });
  }
  deleteAlarm(_opts?: unknown): Promise<void> {
    return this.op(() => this.clearAlarmSync());
  }
  clearAlarmSync(): void {
    this.#meta();
    this.sql.internalExec("DELETE FROM _cf_METADATA WHERE key = 'alarm'");
    this.onAlarmChange(null);
  }
}
