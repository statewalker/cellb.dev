import { createRequire } from "node:module";
import type { ObjectAttributes, ObjectStore } from "./object-store.js";
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
      const r = db
        .prepare("SELECT body, etag, modified_ms, attributes FROM objects WHERE key = ?")
        .get(key) as
        | { body: Uint8Array; etag: number; modified_ms: number; attributes: string }
        | undefined;
      return r
        ? {
            body: new Uint8Array(r.body),
            etag: String(r.etag),
            modifiedMs: Number(r.modified_ms),
            attrs: fromAttributes(r.attributes),
          }
        : undefined;
    },
    async put(key, body, cond, attrs) {
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
          "INSERT OR REPLACE INTO objects (key, body, etag, modified_ms, attributes) VALUES (?, ?, ?, ?, ?)",
        ).run(key, body, next_etag, Date.now(), toAttributes(attrs));
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

// celld dev's `attributes` column: a JSON array of {kind, name, value} — "metadata" entries
// (user metadata, name = key) and one entry per content header ("content-type", …).
type HeaderField =
  | "contentType"
  | "contentLanguage"
  | "contentDisposition"
  | "contentEncoding"
  | "cacheControl";
const HEADERS: [HeaderField, string][] = [
  ["contentType", "content-type"],
  ["contentLanguage", "content-language"],
  ["contentDisposition", "content-disposition"],
  ["contentEncoding", "content-encoding"],
  ["cacheControl", "cache-control"],
];
function toAttributes(attrs?: ObjectAttributes): string {
  const out: { kind: string; name: string | null; value: string }[] = [];
  for (const [name, value] of Object.entries(attrs?.metadata ?? {}))
    out.push({ kind: "metadata", name, value });
  for (const [field, kind] of HEADERS) {
    const v = attrs?.[field];
    if (typeof v === "string") out.push({ kind, name: null, value: v });
  }
  return JSON.stringify(out);
}
function fromAttributes(raw: string): ObjectAttributes | undefined {
  let list: { kind: string; name: string | null; value: string }[];
  try {
    list = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list) || !list.length) return undefined;
  const attrs: ObjectAttributes = {};
  for (const e of list) {
    if (e.kind === "metadata" && e.name) {
      attrs.metadata = attrs.metadata ?? {};
      attrs.metadata[e.name] = e.value;
    }
    const h = HEADERS.find(([, kind]) => kind === e.kind);
    if (h) (attrs as Record<string, unknown>)[h[0]] = e.value;
  }
  return attrs;
}
