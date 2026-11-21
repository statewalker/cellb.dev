/**
 * Byte strings of any size in a Durable Object's SQLite: a row holds at most 2 MB there, so a
 * value is split into 1 MiB chunks. Used for a job's PDF, its pages' JSON and its PNG assets.
 */
import type { Sql } from "./models.ts";

/** Chunk size: a whole number of these is what `append` takes (except a blob's last part). */
export const BLOB_CHUNK = 1024 * 1024;
const CHUNK = BLOB_CHUNK;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BlobStore {
  constructor(private readonly sql: Sql) {
    this.createTables();
  }

  createTables(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS blob_chunk (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS blob (key TEXT PRIMARY KEY, size INTEGER NOT NULL)");
  }

  put(key: string, bytes: Uint8Array): void {
    this.delete(key);
    for (let i = 0; i * CHUNK < bytes.byteLength; i++) {
      this.sql.exec(
        "INSERT INTO blob_chunk (key, idx, data) VALUES (?, ?, ?)",
        key,
        i,
        bytes.subarray(i * CHUNK, (i + 1) * CHUNK),
      );
    }
    this.sql.exec("INSERT INTO blob (key, size) VALUES (?, ?)", key, bytes.byteLength);
  }

  get(key: string): Uint8Array | null {
    const meta = this.sql.exec("SELECT size FROM blob WHERE key = ?", key).toArray()[0];
    if (!meta) return null;
    const bytes = new Uint8Array(Number(meta.size));
    let offset = 0;
    for (const row of this.sql
      .exec("SELECT data FROM blob_chunk WHERE key = ? ORDER BY idx", key)
      .toArray()) {
      const chunk = new Uint8Array(row.data as ArrayBuffer);
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) throw new Error(`EIO: blob '${key}' is incomplete`);
    return bytes;
  }

  /** The blob's size, or null when there is none. */
  size(key: string): number | null {
    const meta = this.sql.exec("SELECT size FROM blob WHERE key = ?", key).toArray()[0];
    return meta ? Number(meta.size) : null;
  }

  /**
   * Adds bytes at the end of a blob (created empty if missing), so a large value can arrive in
   * parts without being held whole. The blob must end on a chunk boundary: every part but the
   * last is a multiple of BLOB_CHUNK.
   */
  append(key: string, bytes: Uint8Array): number {
    const size = this.size(key) ?? 0;
    if (size % CHUNK !== 0) throw new Error(`EINVAL: blob '${key}' was closed by a short part`);
    for (let i = 0; i * CHUNK < bytes.byteLength; i++) {
      this.sql.exec(
        "INSERT INTO blob_chunk (key, idx, data) VALUES (?, ?, ?)",
        key,
        size / CHUNK + i,
        bytes.subarray(i * CHUNK, (i + 1) * CHUNK),
      );
    }
    this.sql.exec(
      "INSERT OR REPLACE INTO blob (key, size) VALUES (?, ?)",
      key,
      size + bytes.byteLength,
    );
    return size + bytes.byteLength;
  }

  /** Bytes [begin, end) of a blob, reading only the chunks they lie in. */
  read(key: string, begin: number, end: number): Uint8Array {
    const size = this.size(key);
    if (size === null) throw new Error(`ENOENT: no blob '${key}'`);
    end = Math.min(end, size);
    if (begin < 0 || begin >= end) return new Uint8Array(0);
    const first = Math.floor(begin / CHUNK);
    const last = Math.floor((end - 1) / CHUNK);
    const out = new Uint8Array(end - begin);
    for (const row of this.sql
      .exec(
        "SELECT idx, data FROM blob_chunk WHERE key = ? AND idx BETWEEN ? AND ? ORDER BY idx",
        key,
        first,
        last,
      )
      .toArray()) {
      const chunk = new Uint8Array(row.data as ArrayBuffer);
      const start = Number(row.idx) * CHUNK;
      const from = Math.max(begin, start);
      const to = Math.min(end, start + chunk.byteLength);
      out.set(chunk.subarray(from - start, to - start), from - begin);
    }
    return out;
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM blob_chunk WHERE key = ?", key);
    this.sql.exec("DELETE FROM blob WHERE key = ?", key);
  }

  putJson(key: string, value: unknown): void {
    this.put(key, encoder.encode(JSON.stringify(value)));
  }

  getJson<T>(key: string): T | null {
    const bytes = this.get(key);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as T) : null;
  }
}
