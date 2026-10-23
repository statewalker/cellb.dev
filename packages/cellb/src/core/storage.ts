import type { ValueCodec } from "../ports.js";
import { CELLD_SCHEMA } from "./celld-schema.js";
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

/**
 * Synchronous KV API of SQLite-backed objects (`ctx.storage.kv`), stored as celld stores it:
 * `_cf_KV(scope, k, v)` with the cell's scope and V8-serialized values (celld-schema.ts).
 */
export class SyncKvStorage {
  #sql: SqlStorage;
  #codec: ValueCodec;
  #ready = false;
  readonly scope: string;

  constructor(sql: SqlStorage, codec: ValueCodec, scope = "") {
    this.#sql = sql;
    this.#codec = codec;
    this.scope = scope;
    sql.rolledBack.add(() => {
      this.#ready = false; // the table may have been created inside the rolled-back transaction
    });
  }
  #init(): void {
    if (this.#ready) return;
    for (const ddl of CELLD_SCHEMA) this.#sql.internalExec(ddl);
    this.#ready = true;
  }
  get<T = unknown>(key: string): T | undefined {
    this.#init();
    const r = this.#sql.internalExec("SELECT v FROM _cf_KV WHERE scope = ? AND k = ?", [
      this.scope,
      key,
    ]);
    if (!r.rows.length) return undefined;
    return this.#codec.decode(new Uint8Array(r.rows[0][0] as ArrayBuffer)) as T;
  }
  put(key: string, value: unknown): void {
    this.#init();
    // As celld: `undefined` is a storable value; what structured clone refuses is a TypeError.
    try {
      structuredClone(value);
    } catch (e) {
      // Browsers prefix the engine message ("Failed to execute 'structuredClone' on …: ").
      throw new TypeError(
        (e as Error).message.replace(/^Failed to execute '[^']+' on '[^']+': /, ""),
      );
    }
    this.#sql.internalExec("INSERT OR REPLACE INTO _cf_KV (scope, k, v) VALUES (?, ?, ?)", [
      this.scope,
      key,
      this.#codec.encode(value),
    ]);
  }
  delete(key: string): boolean {
    this.#init();
    return (
      this.#sql.internalExec("DELETE FROM _cf_KV WHERE scope = ? AND k = ?", [this.scope, key])
        .rowsWritten > 0
    );
  }
  *list<T = unknown>(opts: ListOptions = {}): IterableIterator<[string, T]> {
    this.#init();
    const where: string[] = ["scope = ?"];
    const params: unknown[] = [this.scope];
    if (opts.start !== undefined) where.push("k >= ?"), params.push(opts.start);
    if (opts.startAfter !== undefined) where.push("k > ?"), params.push(opts.startAfter);
    if (opts.end !== undefined) where.push("k < ?"), params.push(opts.end);
    if (opts.prefix !== undefined)
      where.push("substr(k, 1, ?) = ?"), params.push(opts.prefix.length, opts.prefix);
    let q = "SELECT k, v FROM _cf_KV";
    q += ` WHERE ${where.join(" AND ")}`;
    q += ` ORDER BY k ${opts.reverse ? "DESC" : "ASC"}`;
    if (opts.limit !== undefined) (q += " LIMIT ?"), params.push(opts.limit);
    for (const [k, v] of this.#sql.internalExec(q, params).rows)
      yield [k as string, this.#codec.decode(new Uint8Array(v as ArrayBuffer)) as T];
  }
  deleteAll(): void {
    this.#init();
    this.#sql.internalExec("DELETE FROM _cf_KV WHERE scope = ?", [this.scope]);
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

// celld sets no limit on the number of keys of one get/put/delete (storage-details).
function checkKeys(_keys: string[]): void {}

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
    sql.rolledBack.add(() => {
      this.#metaReady = false;
    });
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
        if (txn.rolledBack) this.#rollbackTo(sp);
        else this.sql.internalExec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.#rollbackTo(sp);
        throw e;
      } finally {
        release();
      }
    });
  }
  #rollbackTo(sp: string): void {
    this.sql.internalExec(`ROLLBACK TO ${sp}`);
    this.sql.internalExec(`RELEASE ${sp}`);
    for (const f of this.sql.rolledBack) f(); // tables created inside may be gone
  }
  /** Resolves once all writes so far are durable (the output gate barrier). */
  sync(): Promise<void> {
    return this.#sync();
  }
  /** Called whenever the stored alarm changes (the runtime schedules it). */
  onAlarmChange: (at: number | null) => void = () => {};

  #metaReady = false;
  #meta(): void {
    if (this.#metaReady) return;
    for (const ddl of CELLD_SCHEMA) this.sql.internalExec(ddl);
    this.#metaReady = true;
  }
  /**
   * The alarm row as celld keeps it (storage.rs): due time, failure counters, and a random
   * generation that changes with every setAlarm() — so a handler's own change is detected.
   */
  alarmRowSync(): { at: number; retry: number; counted: number; generation: string } | null {
    this.#meta();
    const r = this.sql.internalExec(
      // generation is a 64-bit random(): read as text (beyond JS's safe integers)
      "SELECT at_ms, retry, counted_retry, CAST(generation AS TEXT) FROM _cf_ALARM WHERE scope = ?",
      [this.kv.scope],
    ).rows[0];
    return r
      ? { at: Number(r[0]), retry: Number(r[1]), counted: Number(r[2]), generation: String(r[3]) }
      : null;
  }
  /** The alarm being handled: getAlarm() reads null until the handler changes the alarm. */
  #active: { generation: string } | undefined;
  beginAlarm(row: { generation: string }): void {
    this.#active = { generation: row.generation };
  }
  /**
   * After the handler (celld's finish_alarm_handler): unless the handler changed the alarm,
   * success deletes it and failure reschedules it with backoff (2 s << min(retry, 6)) —
   * abandoned after 6 counted failures. Returns the alarm now stored.
   */
  finishAlarm(
    fired: { at: number; generation: string },
    succeeded: boolean,
    now: number,
  ): number | null {
    this.#active = undefined;
    const cur = this.alarmRowSync();
    if (!cur || cur.generation !== fired.generation) return cur?.at ?? null;
    if (succeeded) {
      this.sql.internalExec("DELETE FROM _cf_ALARM WHERE scope = ? AND at_ms = ?", [
        this.kv.scope,
        fired.at,
      ]);
    } else if (cur.counted >= 6) {
      this.sql.internalExec("DELETE FROM _cf_ALARM WHERE scope = ?", [this.kv.scope]);
    } else {
      const at = now + 2_000 * 2 ** Math.min(Math.max(cur.retry, 0), 6);
      this.sql.internalExec(
        "UPDATE _cf_ALARM SET at_ms = ?, retry = retry + 1, counted_retry = counted_retry + 1 WHERE scope = ?",
        [at, this.kv.scope],
      );
    }
    const after = this.alarmRowSync()?.at ?? null;
    this.onAlarmChange(after);
    return after;
  }
  /** Synchronous read of the stored alarm (ms since epoch) or null (null while it is handled). */
  alarmSync(): number | null {
    const row = this.alarmRowSync();
    if (row && this.#active && this.#active.generation === row.generation) return null;
    return row ? row.at : null;
  }
  /** One alarm per object, in celld's `_cf_ALARM` (same transaction as the event's writes). */
  getAlarm(_opts?: unknown): Promise<number | null> {
    return this.op(() => this.alarmSync());
  }
  setAlarm(scheduledTime: number | Date, _opts?: unknown): Promise<void> {
    // As celld: the time is coerced to a number and a non-number becomes 0 (due at once).
    const n = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
    const at = Number.isNaN(n) ? 0 : n;
    return this.op(() => {
      this.#meta();
      this.sql.internalExec(
        // celld's statement: counters reset, a new random generation
        "INSERT INTO _cf_ALARM(scope,at_ms,retry,counted_retry,generation) VALUES(?,?,0,0,random()) ON CONFLICT(scope) DO UPDATE SET at_ms=excluded.at_ms, retry=0, counted_retry=0, generation=random()",
        [this.kv.scope, at],
      );
      this.onAlarmChange(at);
    });
  }
  deleteAlarm(_opts?: unknown): Promise<void> {
    return this.op(() => this.clearAlarmSync());
  }
  clearAlarmSync(): void {
    this.#meta();
    this.sql.internalExec("DELETE FROM _cf_ALARM WHERE scope = ?", [this.kv.scope]);
    this.onAlarmChange(null);
  }
}
