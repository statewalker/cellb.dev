import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { Lease, LeaseHandle } from "../ports.js";

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
