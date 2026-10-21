import type {
  BackupInfo,
  CellBackup,
  CellDurability,
  OpenCellSql,
  SyncSqlDriver,
  ValueCodec,
} from "../ports.js";
import { InputGate, OutputGate } from "./gates.js";
import { asyncStub, isClassHandle } from "./handles.js";
import { type DurableObjectId, DurableObjectId as DurableObjectIdClass } from "./id.js";
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
    /** `ctx.exports` (loopback handles of the Worker's exports). */
    exports?: Record<string, unknown>;
    /** SQLite extensions to load into every cell database (e.g. "sqlite_vec"). */
    sqlExtensions?: string[];
    /**
     * Ownership: acquire the cell's lease before restoring it. No lease → the cell is owned
     * elsewhere (the host refuses events). The lease epoch fences the cell's log segments;
     * losing the lease breaks the host so it stops serving.
     */
    acquire?: (cellKey: string) => Promise<{ epoch: number; lost: AbortSignal } | undefined>;
  }) {
    this.#backup = opts.backup;
    this.cellKey = opts.cellKey;
    this.#driver = opts.openSql(opts.cellKey);
    for (const ext of opts.sqlExtensions ?? []) {
      if (!this.#driver.loadExtension)
        throw new Error(`SQLite extension "${ext}" is not available on this host`);
      this.#driver.loadExtension(ext);
    }
    this.#sql = new SqlStorage(
      this.#driver,
      (changes) => {
        if (changes && this.#epoch !== undefined) changes.epoch = this.#epoch;
        return this.#out.track(
          opts.durability.committed(this.cellKey, { seq: ++this.#seq, changes }),
        );
      },
      { capture: !!opts.durability.captureChanges },
    );
    const kv = new SyncKvStorage(this.#sql, opts.codec);
    const storage = new DurableObjectStorage(this.#sql, kv, this.#gate, () => this.#barrier());
    if (opts.onAlarmChange) storage.onAlarmChange = opts.onAlarmChange;
    const state = new DurableObjectState(opts.id, storage, this.#gate, opts.waitUntil, (e) =>
      this.#breakOn(e),
    );
    this.state = state;
    state.attachDispatcher((fn) => this.deliver(fn));
    state.exports = opts.exports ?? {};
    state.facets = createFacets(
      opts,
      (name, cls, env, id) =>
        new ObjectHost({
          ...opts,
          cellKey: `${opts.cellKey}/facets/${name}`,
          id,
          cls,
          env,
          onAlarmChange: undefined,
        }),
    );
    const construct = () => (this.#instance = new opts.cls(state, opts.env));
    this.#construct = construct;
    const load = opts.backup?.load;
    const replay = opts.backup?.replay;
    const acquire = opts.acquire;
    if (!load && !replay && !acquire) {
      construct();
      return;
    }
    // Restore-on-open: events queue behind the closed gate until the image is in.
    void this.#gate
      .runClosed(async () => {
        if (acquire) {
          const lease = await acquire(this.cellKey);
          if (!lease) throw new CellOwnedElsewhereError(this.cellKey);
          this.#epoch = lease.epoch;
          lease.lost.addEventListener(
            "abort",
            () => this.#breakOn(new Error(`lease of ${this.cellKey} lost`)),
            {
              once: true,
            },
          );
        }
        const empty =
          Number(this.#driver.exec("SELECT count(*) FROM sqlite_master", []).rows[0][0]) === 0;
        if (empty) {
          const image = await load?.(this.cellKey);
          if (image) {
            if (!this.#driver.restore)
              throw new Error("SyncSqlDriver has no restore(): cannot restore a backup");
            this.#driver.restore(image);
          }
          // Then every logged transaction the image does not contain, in order.
          if (replay) await this.#replayLog(replay);
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
    let logSeq = 0;
    try {
      logSeq = Number(
        this.#driver.exec("SELECT value FROM _cf_METADATA WHERE key = 'log_seq'", [])
          .rows[0]?.[0] ?? 0,
      );
    } catch {
      // no _cf_METADATA yet
    }
    const image = this.#driver.snapshot();
    this.#saving = b
      .save(this.cellKey, image, { seq, takenAt: now, reason, logSeq })
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
        this.#active++;
        try {
          started = Promise.resolve(fn(this.#instance, this.state));
        } catch (e) {
          started = Promise.reject(e);
        }
        const done = () => {
          this.#active--;
          this.lastActive = Date.now();
        };
        started.then(
          (r) => {
            this.#pinIfStandardWebSocket(r);
            this.#barrier().then(
              () => (done(), resolve(r)),
              (e) => (done(), reject(e)),
            );
          },
          (e) =>
            this.#barrier().then(
              () => (done(), reject(e)),
              (e2) => (done(), reject(e2)),
            ),
        );
      });
      this.#pump();
    });
  }

  #queue: (() => void)[] = [];
  #pumpWaiting = false;
  #pump = (): void => {
    this.#pumpWaiting = false;
    while (this.#queue.length && this.#gate.isOpen) {
      // Waking from hibernation: the constructor runs again before the event (and may
      // close the gate with blockConcurrencyWhile, which the loop then respects).
      if (this.#hibernated) {
        this.#hibernated = false;
        this.#construct?.();
        continue;
      }
      this.#queue.shift()!();
    }
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

  /** Applies log segments newer than the database's own log sequence (restore path). */
  async #replayLog(replay: NonNullable<CellBackup["replay"]>): Promise<void> {
    const d = this.#driver;
    d.exec("CREATE TABLE IF NOT EXISTS _cf_METADATA (key TEXT PRIMARY KEY, value)", []);
    const row = d.exec("SELECT value FROM _cf_METADATA WHERE key = 'log_seq'", []).rows[0];
    const after = Number(row?.[0] ?? 0);
    for await (const seg of replay(this.cellKey, after)) {
      if (!d.applyChangeset)
        throw new Error("SyncSqlDriver cannot apply changesets: cannot replay a log");
      d.exec("BEGIN", []);
      try {
        for (const ddl of seg.ddl) d.exec(ddl, []);
        d.applyChangeset(seg.changeset);
        for (const [sql, params] of seg.statements) d.exec(sql, params);
        d.exec("INSERT OR REPLACE INTO _cf_METADATA (key, value) VALUES ('log_seq', ?)", [
          seg.logSeq,
        ]);
        d.exec("COMMIT", []);
      } catch (e) {
        d.exec("ROLLBACK", []);
        throw e;
      }
    }
  }

  #construct?: () => unknown;
  #epoch: number | undefined;

  // ---- hibernation ---------------------------------------------------------------------
  #active = 0;
  #hibernated = false;
  #pinned = 0;
  /** Time of the last event's completion (the runtime's idle sweep reads it). */
  lastActive = Date.now();

  get hibernated(): boolean {
    return this.#hibernated;
  }

  /**
   * A 101 response whose server end was accepted with `accept()` (not acceptWebSocket)
   * holds a standard WebSocket: the object cannot hibernate until that socket closes —
   * as on Cloudflare, only the hibernation API lets an object sleep with open sockets.
   */
  #pinIfStandardWebSocket(r: unknown): void {
    const server = (
      r as { webSocket?: { peer?: { accepted: boolean; hibernatable: boolean } & EventTarget } }
    )?.webSocket?.peer;
    if (!server || server.hibernatable || !server.accepted) return;
    this.#pinned++;
    server.addEventListener("close", () => this.#pinned--, { once: true });
  }

  /**
   * Drops the instance when nothing runs: no event in flight or queued, no open async
   * transaction, no standard WebSocket. Storage, alarms and hibernatable sockets stay; the
   * next event constructs the class again. Returns whether it hibernated.
   */
  hibernate(): boolean {
    if (
      this.#hibernated ||
      this.broken ||
      this.#active ||
      this.#queue.length ||
      this.#sql.held ||
      this.#pinned
    )
      return false;
    if (!this.#gate.isOpen) return false;
    this.#sql.commit();
    this.#instance = undefined;
    this.#hibernated = true;
    return true;
  }
  /** Replaces the instance with a fresh one on the SAME database (facet abort/delete). */
  restart(): void {
    this.#construct?.();
  }
}

/**
 * `ctx.facets` (celld docs/services/durable-object-facets.md): named child objects with a
 * SQLite database of their own (`<cellKey>/facets/<name>`), started on first call from a
 * class (or class handle) returned by the callback; the name alone selects the database.
 */
function createFacets(
  parent: { id: DurableObjectId; env: unknown },
  spawn: (name: string, cls: DurableObjectClass, env: unknown, id: DurableObjectId) => ObjectHost,
) {
  const running = new Map<string, Promise<ObjectHost>>();
  // abort() stops the stubs handed out so far (their calls throw the reason); a later
  // get() starts the facet again on the same database — as celld does.
  const generation = new Map<string, { n: number; reason?: unknown }>();
  const hostOf = (name: string, start?: () => unknown): Promise<ObjectHost> => {
    let p = running.get(name);
    if (!p) {
      if (!start) return Promise.reject(new Error(`Facet "${name}" is not running`));
      p = (async () => {
        const info = (await start()) as { class: unknown; id?: unknown };
        let cls: DurableObjectClass;
        let env = parent.env;
        if (isClassHandle(info.class)) ({ cls, env } = await info.class.resolve());
        else cls = info.class as DurableObjectClass;
        const id = info.id instanceof DurableObjectIdClass ? info.id : parent.id;
        return spawn(name, cls, env, id);
      })();
      p.catch(() => running.delete(name));
      running.set(name, p);
    }
    return p;
  };
  return {
    get(name: string, start: () => unknown) {
      if (new TextEncoder().encode(name).byteLength > 256)
        throw new Error("A facet name has a limit of 256 bytes");
      const gen = generation.get(name)?.n ?? 0;
      const live = () => {
        const g = generation.get(name);
        if (g && g.n !== gen) throw g.reason;
      };
      return asyncStub(
        async (method, args) =>
          (live(), await hostOf(name, start)).deliver((obj) => {
            const fn = obj[method];
            if (typeof fn !== "function")
              throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
            return fn.apply(obj, args);
          }),
        async (req) => (live(), await hostOf(name, start)).deliver((obj) => obj.fetch(req)),
      );
    },
    abort(name: string, reason?: unknown) {
      const n = (generation.get(name)?.n ?? 0) + 1;
      generation.set(name, { n, reason: reason ?? new Error(`Facet "${name}" was aborted`) });
      // The database stays: the next call on a new stub gets a fresh instance over it.
      void running.get(name)?.then((h) => h.restart());
    },
    async delete(name: string) {
      const p = running.get(name);
      generation.set(name, {
        n: (generation.get(name)?.n ?? 0) + 1,
        reason: new Error(`Facet "${name}" was deleted`),
      });
      if (p) {
        const h = await p;
        await h.deliver((_o, state) => state.storage.deleteAll());
        h.restart();
        running.set(name, p);
      }
    },
  };
}

/** The cell's lease is held by another owner (route the request there, or retry later). */
export class CellOwnedElsewhereError extends Error {
  constructor(cellKey: string) {
    super(`Durable Object ${cellKey} is owned by another node`);
    this.name = "CellOwnedElsewhereError";
  }
}
