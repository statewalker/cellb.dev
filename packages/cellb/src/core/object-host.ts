import type {
  BackupInfo,
  CellBackup,
  CellDurability,
  OpenCellSql,
  SyncSqlDriver,
  ValueCodec,
} from "../ports.js";
import { InputGate, OutputGate } from "./gates.js";
import type { DurableObjectId } from "./id.js";
import { SqlStorage } from "./sql-storage.js";
import { DurableObjectState } from "./state.js";
import { DurableObjectStorage, SyncKvStorage } from "./storage.js";

export type DurableObjectClass = new (ctx: DurableObjectState, env: any) => any;

export class BrokenObjectError extends Error {
  constructor(cause: unknown, reason = "its storage failed to commit durably") {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Durable Object reset because ${reason}${detail}`, { cause });
    this.name = "BrokenObjectError";
  }
}

/**
 * One live instance of one Durable Object: its SQLite, gates and dispatcher.
 * Everything that reaches the object (fetch, RPC, later alarms/WebSockets)
 * goes through `deliver()`.
 */
export class ObjectHost {
  readonly cellKey: string;
  readonly #gate = new InputGate();
  readonly #out = new OutputGate();
  readonly #driver: SyncSqlDriver;
  readonly #sql: SqlStorage;
  #instance: any;
  readonly #backup?: CellBackup;
  #backedUpSeq = 0;
  #saving: Promise<void> | undefined;
  readonly state: DurableObjectState;
  #seq = 0;
  broken = false;
  #brokenCause: unknown;

  /** blockConcurrencyWhile() rejected (CF: the object is reset; queued events fail). */
  #breakOn(e: unknown): void {
    this.broken = true;
    this.#brokenCause = e;
  }

  constructor(opts: {
    cellKey: string;
    id: DurableObjectId;
    cls: DurableObjectClass;
    env: unknown;
    openSql: OpenCellSql;
    durability: CellDurability;
    codec: ValueCodec;
    waitUntil: (p: Promise<unknown>) => void;
    backup?: CellBackup;
    /** The stored alarm changed (null = cleared). */
    onAlarmChange?: (at: number | null) => void;
  }) {
    this.#backup = opts.backup;
    this.cellKey = opts.cellKey;
    this.#driver = opts.openSql(opts.cellKey);
    this.#sql = new SqlStorage(this.#driver, () =>
      this.#out.track(opts.durability.committed(this.cellKey, { seq: ++this.#seq })),
    );
    const kv = new SyncKvStorage(this.#sql, opts.codec);
    const storage = new DurableObjectStorage(this.#sql, kv, this.#gate, () => this.#barrier());
    if (opts.onAlarmChange) storage.onAlarmChange = opts.onAlarmChange;
    const state = new DurableObjectState(opts.id, storage, this.#gate, opts.waitUntil, (e) =>
      this.#breakOn(e),
    );
    this.state = state;
    const construct = () => (this.#instance = new opts.cls(state, opts.env));
    const load = opts.backup?.load;
    if (!load) {
      construct();
      return;
    }
    // Restore-on-open: events queue behind the closed gate until the image is in.
    void this.#gate
      .runClosed(async () => {
        const empty =
          Number(this.#driver.exec("SELECT count(*) FROM sqlite_master", []).rows[0][0]) === 0;
        if (empty) {
          const image = await load(this.cellKey);
          if (image) {
            if (!this.#driver.restore)
              throw new Error("SyncSqlDriver has no restore(): cannot restore a backup");
            this.#driver.restore(image);
          }
        }
        construct();
      })
      .catch((e) => this.#breakOn(e));
  }

  /**
   * Takes a snapshot if the cell changed since the last successful save and hands
   * it to `backup.save`. Synchronous snapshot between events → consistent image.
   * Skipped while an async transaction() holds the database or a save is running.
   */
  backupIfDirty(reason: BackupInfo["reason"], now: number): Promise<void> {
    const b = this.#backup;
    if (!b || this.broken || this.#saving || this.#seq === this.#backedUpSeq)
      return this.#saving ?? Promise.resolve();
    if (!this.#driver.snapshot)
      return Promise.reject(new Error("SyncSqlDriver has no snapshot(): cannot back up"));
    if (this.#sql.held) return Promise.resolve(); // mid-transaction: next round
    this.#sql.commit();
    const seq = this.#seq;
    const image = this.#driver.snapshot();
    this.#saving = b
      .save(this.cellKey, image, { seq, takenAt: now, reason })
      .then(
        () => {
          this.#backedUpSeq = Math.max(this.#backedUpSeq, seq);
        },
        (e) => b.onError?.(this.cellKey, e),
      )
      .finally(() => (this.#saving = undefined));
    return this.#saving;
  }

  /**
   * Input gate → handler → commit → output gate (durability) → result.
   *
   * Events are queued and STARTED synchronously by a pump only while the gate
   * is open: the first storage op of a handler closes the gate before the
   * next event can start (checking the gate in an `await` continuation is too
   * late — every queued continuation would see it open).
   */
  deliver<T>(fn: (instance: any, state: DurableObjectState) => T | Promise<T>): Promise<T> {
    if (this.broken) return Promise.reject(new BrokenObjectError(undefined));
    return new Promise<T>((resolve, reject) => {
      this.#queue.push(() => {
        if (this.broken)
          return reject(new BrokenObjectError(this.#brokenCause, "its initialization failed"));
        let started: Promise<T>;
        try {
          started = Promise.resolve(fn(this.#instance, this.state));
        } catch (e) {
          started = Promise.reject(e);
        }
        started.then(
          (r) => this.#barrier().then(() => resolve(r), reject),
          (e) => this.#barrier().then(() => reject(e), reject),
        );
      });
      this.#pump();
    });
  }

  #queue: (() => void)[] = [];
  #pumpWaiting = false;
  #pump = (): void => {
    this.#pumpWaiting = false;
    while (this.#queue.length && this.#gate.isOpen) this.#queue.shift()!();
    if (this.#queue.length && !this.#pumpWaiting) {
      this.#pumpWaiting = true;
      this.#gate.onOpen(this.#pump);
    }
  };

  async #barrier(): Promise<void> {
    try {
      this.#sql.commit();
      await this.#out.barrier();
    } catch (e) {
      this.broken = true;
      try {
        this.#sql.rollback();
      } catch {}
      throw new BrokenObjectError(e);
    }
  }

  close(): void {
    this.#driver.close();
  }
}
