import { createRequire } from "node:module";
import type { ObjectStore } from "./object-store.js";
import { PreconditionFailedError } from "./object-store.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * celld dev's local bucket: `<project>/.celld/dev/objects.sqlite3` (objects(key, body, etag
 * INTEGER, modified_ms, attributes) + store_sequence). Reading and writing it lets a
 * webrun-cells node and `celld dev` share one bucket — the migration path of note 22.
 * Conditional writes are real (one SQLite transaction).
 */
export function sqliteObjectStore(file: string): ObjectStore & { close(): void } {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS objects (
    key TEXT PRIMARY KEY, body BLOB NOT NULL, etag INTEGER NOT NULL,
    modified_ms INTEGER NOT NULL, attributes TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS store_sequence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_etag INTEGER NOT NULL)`);
  db.exec("INSERT OR IGNORE INTO store_sequence (singleton, next_etag) VALUES (1, 1)");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    async get(key) {
      const r = db.prepare("SELECT body, etag FROM objects WHERE key = ?").get(key) as
        | { body: Uint8Array; etag: number }
        | undefined;
      return r ? { body: new Uint8Array(r.body), etag: String(r.etag) } : undefined;
    },
    async put(key, body, cond) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const cur = db.prepare("SELECT etag FROM objects WHERE key = ?").get(key) as
          | { etag: number }
          | undefined;
        if (cond?.ifNoneMatch === "*" && cur) throw new PreconditionFailedError(key);
        if (cond?.ifMatch !== undefined && String(cur?.etag) !== cond.ifMatch)
          throw new PreconditionFailedError(key);
        const { next_etag } = db
          .prepare("SELECT next_etag FROM store_sequence WHERE singleton = 1")
          .get() as {
          next_etag: number;
        };
        db.prepare("UPDATE store_sequence SET next_etag = ? WHERE singleton = 1").run(
          next_etag + 1,
        );
        db.prepare(
          "INSERT OR REPLACE INTO objects (key, body, etag, modified_ms, attributes) VALUES (?, ?, ?, ?, '[]')",
        ).run(key, body, next_etag, Date.now());
        db.exec("COMMIT");
        return String(next_etag);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async list(prefix) {
      return (
        db
          .prepare("SELECT key FROM objects WHERE key >= ? AND key < ? ORDER BY key")
          .all(prefix, `${prefix}\uffff`) as {
          key: string;
        }[]
      ).map((r) => r.key);
    },
    async delete(key) {
      db.prepare("DELETE FROM objects WHERE key = ?").run(key);
    },
    close() {
      db.close();
    },
  };
}
