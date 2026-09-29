import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import {
  type ConditionalStore,
  PreconditionFailedError,
  type Versioned,
} from "../lease/conditional-store.js";
import type { Lease, LeaseHandle } from "../lease/lease.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * Single-host lease = an SQLite file held in EXCLUSIVE locking mode.
 * SQLite takes an OS (POSIX fcntl) lock on the file and never releases it in
 * this mode; the OS drops it when the process dies (kill -9 included) — no
 * stale-lock heuristics, unlike lockfiles. The file also stores the epoch.
 * Not for network filesystems (fcntl locks over NFS are unreliable).
 */
export class SqliteFileLease implements Lease {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async tryAcquire(name: string): Promise<LeaseHandle | undefined> {
    const db = new DatabaseSync(`${this.dir}/${name.replace(/[^\w.-]/g, "_")}.lease.sqlite`);
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;");
      db.exec("BEGIN EXCLUSIVE"); // throws SQLITE_BUSY if another connection/process holds it
      db.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL)",
      );
      db.exec(
        "INSERT INTO lease (id, epoch) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1",
      );
      const { epoch } = db.prepare("SELECT epoch FROM lease WHERE id = 1").get() as {
        epoch: number;
      };
      db.exec("COMMIT"); // the EXCLUSIVE file lock stays held (locking_mode = EXCLUSIVE)
      const ac = new AbortController();
      return {
        name,
        epoch: Number(epoch),
        lost: ac.signal, // an OS lock is not lost while the process lives
        async release() {
          ac.abort(new Error("released"));
          db.close();
        },
      };
    } catch (e) {
      db.close();
      if (/locked|busy/i.test(String((e as Error).message))) return undefined;
      throw e;
    }
  }
}

/**
 * ConditionalStore on a shared SQLite file: CAS with a single conditional
 * statement. Works across processes on one host; same contract as S3, so the
 * CasLease/FencedManifest logic is exercised without a bucket.
 */
export class SqliteConditionalStore implements ConditionalStore {
  readonly #db: DatabaseSyncT;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL)",
    );
  }
  async get(key: string): Promise<Versioned | undefined> {
    const r = this.#db.prepare("SELECT body, version FROM objects WHERE key = ?").get(key) as
      | { body: string; version: number }
      | undefined;
    return r && { body: r.body, etag: `"${r.version}"` };
  }
  async put(
    key: string,
    body: string,
    cond: { ifMatch: string } | { ifNoneMatch: "*" },
  ): Promise<{ etag: string }> {
    let changes: number | bigint;
    if ("ifNoneMatch" in cond) {
      changes = this.#db
        .prepare(
          "INSERT INTO objects (key, body, version) VALUES (?, ?, 1) ON CONFLICT(key) DO NOTHING",
        )
        .run(key, body).changes;
    } else {
      const v = Number(cond.ifMatch.replace(/"/g, ""));
      changes = this.#db
        .prepare("UPDATE objects SET body = ?, version = version + 1 WHERE key = ? AND version = ?")
        .run(body, key, v).changes;
    }
    if (Number(changes) === 0) throw new PreconditionFailedError(key);
    return { etag: (await this.get(key))!.etag };
  }
  close(): void {
    this.#db.close();
  }
}
