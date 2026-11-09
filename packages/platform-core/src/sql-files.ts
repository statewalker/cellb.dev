/**
 * A FilesApi over a Durable Object's SQLite storage (`ctx.storage.sql`).
 *
 * Content is stored in blocks of at most 256 KiB, so every row stays well under the 2 MB value
 * limit of Cloudflare's Durable Objects (celld and cellb store cells in the same SQLite format).
 * Directories are implicit (a directory exists when a file below it does) unless created with
 * `mkdir`. Several FilesApis can share one object: each one has its own table prefix.
 *
 * Listing order is SQLite's BINARY collation on UTF-8 paths, which is Unicode code point order,
 * as the FilesApi contract asks (`comparePaths`).
 */
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";

export const BLOCK_SIZE = 256 * 1024;

function norm(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return `/${parts.join("/")}`;
}
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const under = (dir: string) => (dir === "/" ? "/" : `${dir}/`);
/**
 * Bounds of the paths below `prefix` (which ends in "/"): `path >= lo AND path < hi`. A range,
 * not `LIKE`: workerd limits the length of LIKE patterns, and a range uses the primary key.
 */
const bounds = (prefix: string): [string, string] => [prefix, `${prefix.slice(0, -1)}0`];

export class SqlFilesApi implements FilesApi {
  readonly #sql: SqlStorage;
  readonly #f: string;
  readonly #b: string;
  readonly #d: string;

  constructor(sql: SqlStorage, prefix = "fs") {
    if (!/^[a-z_][a-z0-9_]*$/i.test(prefix)) throw new Error(`bad table prefix: ${prefix}`);
    this.#sql = sql;
    this.#f = `${prefix}_files`;
    this.#b = `${prefix}_blocks`;
    this.#d = `${prefix}_dirs`;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#f} (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${this.#b} (path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.#d} (path TEXT PRIMARY KEY)`);
  }

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const p = norm(path);
    const row = this.#sql
      .exec<{ size: number }>(`SELECT size FROM ${this.#f} WHERE path = ?`, p)
      .toArray()[0];
    if (!row) return;
    const size = Number(row.size);
    const start = Math.max(0, Math.min(options.start ?? 0, size));
    const end = options.length === undefined ? size : Math.min(size, start + options.length);
    if (end <= start) return;
    const first = Math.floor(start / BLOCK_SIZE);
    const last = Math.floor((end - 1) / BLOCK_SIZE);
    for (let i = first; i <= last; i++) {
      options.signal?.throwIfAborted();
      const b = this.#sql
        .exec<{ data: ArrayBuffer }>(`SELECT data FROM ${this.#b} WHERE path = ? AND idx = ?`, p, i)
        .toArray()[0];
      if (!b) return;
      const bytes = new Uint8Array(b.data);
      const from = i === first ? start - i * BLOCK_SIZE : 0;
      const to = i === last ? end - i * BLOCK_SIZE : bytes.length;
      yield bytes.subarray(from, to);
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const p = norm(path);
    // Collected before writing: SQL calls are synchronous, so the rows land in one turn.
    const blocks: Uint8Array[] = [];
    let pending = new Uint8Array(BLOCK_SIZE);
    let fill = 0;
    let size = 0;
    for await (const chunk of content as AsyncIterable<Uint8Array>) {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(BLOCK_SIZE - fill, chunk.length - off);
        pending.set(chunk.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === BLOCK_SIZE) {
          blocks.push(pending);
          pending = new Uint8Array(BLOCK_SIZE);
          fill = 0;
        }
      }
      size += chunk.length;
    }
    if (fill > 0) blocks.push(pending.subarray(0, fill));
    this.#sql.exec(`DELETE FROM ${this.#b} WHERE path = ?`, p);
    blocks.forEach((b, i) => {
      this.#sql.exec(`INSERT INTO ${this.#b} (path, idx, data) VALUES (?, ?, ?)`, p, i, b);
    });
    this.#sql.exec(
      `INSERT INTO ${this.#f} (path, size, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime`,
      p,
      size,
      Date.now(),
    );
  }

  async mkdir(path: string): Promise<void> {
    const p = norm(path);
    if (p !== "/") this.#sql.exec(`INSERT OR IGNORE INTO ${this.#d} (path) VALUES (?)`, p);
  }

  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const dir = norm(path);
    const prefix = under(dir);
    const files = this.#sql
      .exec<{ path: string; size: number; mtime: number }>(
        `SELECT path, size, mtime FROM ${this.#f} WHERE path >= ? AND path < ? ORDER BY path`,
        ...bounds(prefix),
      )
      .toArray();
    const dirs = this.#sql
      .exec<{ path: string }>(
        `SELECT path FROM ${this.#d} WHERE path >= ? AND path < ?`,
        ...bounds(prefix),
      )
      .toArray()
      .map((r) => r.path);
    const entries = new Map<string, FileInfo>();
    const addDir = (p: string) => {
      if (!entries.has(p)) entries.set(p, { kind: "directory", name: nameOf(p), path: p });
    };
    for (const d of dirs) {
      const rel = d.slice(prefix.length).split("/");
      if (options.recursive)
        for (let i = 1; i <= rel.length; i++) addDir(prefix + rel.slice(0, i).join("/"));
      else addDir(prefix + rel[0]);
    }
    for (const f of files) {
      const rel = f.path.slice(prefix.length).split("/");
      if (rel.length === 1) {
        entries.set(f.path, {
          kind: "file",
          name: rel[0],
          path: f.path,
          size: Number(f.size),
          lastModified: Number(f.mtime),
        });
      } else if (options.recursive) {
        for (let i = 1; i < rel.length; i++) addDir(prefix + rel.slice(0, i).join("/"));
        entries.set(f.path, {
          kind: "file",
          name: rel[rel.length - 1],
          path: f.path,
          size: Number(f.size),
          lastModified: Number(f.mtime),
        });
      } else addDir(prefix + rel[0]);
    }
    const sorted = [...entries.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const e of sorted) if (!options.after || e.path > options.after) yield e;
  }

  async stats(path: string): Promise<FileStats | undefined> {
    const p = norm(path);
    if (p === "/") return { kind: "directory" };
    const f = this.#sql
      .exec<{ size: number; mtime: number }>(`SELECT size, mtime FROM ${this.#f} WHERE path = ?`, p)
      .toArray()[0];
    if (f) return { kind: "file", size: Number(f.size), lastModified: Number(f.mtime) };
    if (this.#sql.exec(`SELECT 1 FROM ${this.#d} WHERE path = ?`, p).toArray().length)
      return { kind: "directory" };
    const b = bounds(under(p));
    const below =
      this.#sql
        .exec(`SELECT 1 FROM ${this.#f} WHERE path >= ? AND path < ? LIMIT 1`, ...b)
        .toArray().length ||
      this.#sql
        .exec(`SELECT 1 FROM ${this.#d} WHERE path >= ? AND path < ? LIMIT 1`, ...b)
        .toArray().length;
    return below ? { kind: "directory" } : undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    const p = norm(path);
    const st = await this.stats(p);
    if (!st) return false;
    if (st.kind === "file") {
      this.#sql.exec(`DELETE FROM ${this.#f} WHERE path = ?`, p);
      this.#sql.exec(`DELETE FROM ${this.#b} WHERE path = ?`, p);
      return true;
    }
    const b = bounds(under(p));
    this.#sql.exec(`DELETE FROM ${this.#f} WHERE path >= ? AND path < ?`, ...b);
    this.#sql.exec(`DELETE FROM ${this.#b} WHERE path >= ? AND path < ?`, ...b);
    this.#sql.exec(`DELETE FROM ${this.#d} WHERE (path >= ? AND path < ?) OR path = ?`, ...b, p);
    return true;
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, false);
  }

  async move(source: string, target: string): Promise<boolean> {
    return this.#transfer(source, target, true);
  }

  async #transfer(source: string, target: string, move: boolean): Promise<boolean> {
    const s = norm(source);
    const t = norm(target);
    const st = await this.stats(s);
    if (!st) return false;
    if (t === s) return true; // onto itself: nothing to do (and nothing to remove)
    // Into its own subtree: the copies would be read again, and a move would remove them.
    if (st.kind === "directory" && t.startsWith(under(s)))
      throw new Error(`cannot ${move ? "move" : "copy"} ${s} into itself (${t})`);
    const paths =
      st.kind === "file"
        ? [s]
        : this.#sql
            .exec<{ path: string }>(
              `SELECT path FROM ${this.#f} WHERE path >= ? AND path < ?`,
              ...bounds(under(s)),
            )
            .toArray()
            .map((r) => r.path);
    for (const from of paths) {
      const to = t + from.slice(s.length);
      if (to === from) continue;
      this.#sql.exec(`DELETE FROM ${this.#b} WHERE path = ?`, to);
      this.#sql.exec(
        `INSERT INTO ${this.#b} (path, idx, data) SELECT ?, idx, data FROM ${this.#b} WHERE path = ?`,
        to,
        from,
      );
      this.#sql.exec(
        `INSERT INTO ${this.#f} (path, size, mtime) SELECT ?, size, ? FROM ${this.#f} WHERE path = ? ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime`,
        to,
        Date.now(),
        from,
      );
      if (move) {
        this.#sql.exec(`DELETE FROM ${this.#f} WHERE path = ?`, from);
        this.#sql.exec(`DELETE FROM ${this.#b} WHERE path = ?`, from);
      }
    }
    if (st.kind === "directory") {
      await this.mkdir(t);
      if (move) await this.remove(s);
    }
    return true;
  }

  /** Every file path below `dir` (recursive), in path order. */
  filePaths(dir = "/"): string[] {
    const d = norm(dir);
    return this.#sql
      .exec<{ path: string }>(
        `SELECT path FROM ${this.#f} WHERE path >= ? AND path < ? ORDER BY path`,
        ...bounds(under(d)),
      )
      .toArray()
      .map((r) => r.path);
  }

  /** Total bytes of the files below `dir`. */
  totalSize(dir = "/"): number {
    const d = norm(dir);
    const r = this.#sql
      .exec<{ n: number }>(
        `SELECT COALESCE(SUM(size), 0) AS n FROM ${this.#f} WHERE path >= ? AND path < ?`,
        ...bounds(under(d)),
      )
      .one();
    return Number(r.n);
  }
}

export { norm as normalizePath, parentOf };
