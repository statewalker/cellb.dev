// The package store: ONE Durable Object that owns the persistence of npm packages (each a
// "pack", see ../builder/package-cache.ts) and small JSON documents (version index, locks).
// Every other worker (the builder, the download workers) reads and writes through HTTP, so
// no other realm opens the storage: the DO's own SQLite (ctx.storage.sql), on OPFS under cellb
// in a browser, or Cloudflare's in production.
//
//   PUT  …/files/<path>     body → stored in 256 KiB blocks, each deflated
//                           (kept raw where that saves under 10%)   → 204
//   GET  …/files/<path>     Range: bytes=a-b supported             → 200 / 206 / 404
//   HEAD …/files/<path>                                             → 200 (Content-Length) / 404
//   DELETE …/files/<path>                                           → 204 / 404
//
// Clean-up (the host page's "Package cache" buttons):
//
//   GET  …/admin/stats              → { files, packages, locks, size, stored } (JSON; bytes)
//   POST …/admin/clear[?prefix=/p]  every file (or those under the prefix)  → { removed, … }
//   POST …/admin/prune              the packs no lock (/locks/*.json) names, and index.json's
//                                   entries that resolve to them             → { removed, … }
//
// Freed pages are reused by the next writes; the database file itself does not shrink.
//
// Plain JavaScript with no imports: the runtime provides the DurableObject base class (cellb's
// browser realm: globalThis.__cellsWorkersModule; the module stays valid for workerd, where
// `cloudflare:workers` would be imported instead).
const { DurableObject } = globalThis.__cellsWorkersModule;

const BLOCK = 256 * 1024;

/** Bytes through a CompressionStream or DecompressionStream ("deflate-raw"). */
async function through(stream, bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (b) => through(new CompressionStream("deflate-raw"), b);
const inflate = (b) => through(new DecompressionStream("deflate-raw"), b);

export class PackageStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL)",
    );
    // `z`: the block is deflated. The earlier store (uncompressed `blocks`) is a cache: its
    // files are forgotten with it, and fetched again.
    const earlier = this.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'blocks'")
      .toArray().length;
    if (earlier) {
      this.sql.exec("DELETE FROM files");
      this.sql.exec("DROP TABLE blocks");
    }
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS zblocks (path TEXT NOT NULL, idx INTEGER NOT NULL, z INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))",
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const admin = url.pathname.indexOf("/admin/");
    if (admin >= 0) return this.admin(request, url.pathname.slice(admin + "/admin/".length), url);
    const at = url.pathname.indexOf("/files/");
    if (at < 0) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(url.pathname.slice(at + "/files".length));
    if (request.method === "PUT")
      return this.put(path, new Uint8Array(await request.arrayBuffer()));
    if (request.method === "DELETE")
      return new Response(null, { status: this.remove([path]) ? 204 : 404 });
    const row = this.sql.exec("SELECT size FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return new Response(null, { status: 404 });
    const size = Number(row.size);
    if (request.method === "HEAD")
      return new Response(null, { headers: { "content-length": String(size) } });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const start = range ? Math.min(Number(range[1]), size) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]) + 1, size) : size;
    const body = await this.slice(path, start, end);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-length": String(body.length),
        ...(range ? { "content-range": `bytes ${start}-${end - 1}/${size}` } : {}),
      },
    });
  }

  async put(path, bytes) {
    // Compressed before the transaction (it is synchronous): the blocks, then one commit.
    const blocks = [];
    for (let i = 0; i < bytes.length || i === 0; i += BLOCK) {
      const raw = bytes.subarray(i, i + BLOCK);
      const z = raw.length > 64 ? await deflate(raw) : raw;
      blocks.push(z.length < raw.length * 0.9 ? [1, z] : [0, raw]);
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM zblocks WHERE path = ?", path);
      for (const [idx, [z, data]] of blocks.entries())
        this.sql.exec(
          "INSERT INTO zblocks (path, idx, z, data) VALUES (?, ?, ?, ?)",
          path,
          idx,
          z,
          data,
        );
      this.sql.exec("INSERT OR REPLACE INTO files (path, size) VALUES (?, ?)", path, bytes.length);
    });
    return new Response(null, { status: 204 });
  }

  /** The clean-up and statistics routes (see the header). */
  async admin(request, op, url) {
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (op === "stats" && request.method === "GET") return json(this.stats());
    if (request.method !== "POST") return json({ error: `${request.method} ${op}` }, 405);
    if (op === "clear") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const paths = this.sql
        .exec("SELECT path FROM files WHERE substr(path, 1, length(?1)) = ?1", prefix)
        .toArray()
        .map((r) => String(r.path));
      return json({ removed: this.remove(paths), ...this.stats() });
    }
    if (op === "prune") return json(await this.prune());
    return json({ error: `unknown operation ${op}` }, 404);
  }

  /** Files, packs and locks held, their bytes (`size`) and what they take stored (`stored`). */
  stats() {
    const count = (where) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM files ${where}`).toArray()[0].n);
    const size = Number(
      this.sql.exec("SELECT coalesce(sum(size), 0) AS n FROM files").toArray()[0].n,
    );
    const stored = Number(
      this.sql.exec("SELECT coalesce(sum(length(data)), 0) AS n FROM zblocks").toArray()[0].n,
    );
    return {
      files: count(""),
      packages: count("WHERE path LIKE '/pkgs/%'"),
      locks: count("WHERE path LIKE '/locks/%'"),
      size,
      stored,
    };
  }

  /** Removes these files (one transaction): how many existed. */
  remove(paths) {
    let n = 0;
    this.ctx.storage.transactionSync(() => {
      for (const path of paths) {
        this.sql.exec("DELETE FROM zblocks WHERE path = ?", path);
        n += this.sql.exec("DELETE FROM files WHERE path = ?", path).rowsWritten > 0 ? 1 : 0;
      }
    });
    return n;
  }

  async readJson(path) {
    const row = this.sql.exec("SELECT size FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(await this.slice(path, 0, Number(row.size))));
    } catch {
      return undefined;
    }
  }

  /**
   * Keeps the packs that some build's lock names (each lock: the `name@version` list of a
   * build), removes every other one, and drops index.json's ranges that resolve to a removed
   * version. With no lock at all, nothing is removed (`clear` empties the store).
   */
  async prune() {
    const locks = this.sql
      .exec("SELECT path FROM files WHERE path LIKE '/locks/%'")
      .toArray()
      .map((r) => String(r.path));
    if (!locks.length) return { removed: 0, kept: 0, reason: "no lock", ...this.stats() };
    const keep = new Set();
    for (const lock of locks) for (const nv of (await this.readJson(lock)) ?? []) keep.add(nv);
    const packs = this.sql
      .exec("SELECT path FROM files WHERE path LIKE '/pkgs/%.pack'")
      .toArray()
      .map((r) => String(r.path));
    const nameVersion = (path) => path.slice("/pkgs/".length, -".pack".length);
    const removed = packs.filter((p) => !keep.has(nameVersion(p)));
    const index = await this.readJson("/index.json");
    if (index) {
      const left = {};
      for (const [key, version] of Object.entries(index)) {
        // `name@range`: the name's own "@" (a scope) is its first character.
        const at = key.indexOf("@", 1);
        const name = at > 0 ? key.slice(0, at) : key;
        if (keep.has(`${name}@${version}`)) left[key] = version;
      }
      await this.put("/index.json", new TextEncoder().encode(JSON.stringify(left)));
    }
    return {
      removed: this.remove(removed),
      kept: packs.length - removed.length,
      ...this.stats(),
    };
  }

  /** Bytes [start, end) of a file: only the blocks the range covers are read. */
  async slice(path, start, end) {
    const out = new Uint8Array(Math.max(0, end - start));
    if (!out.length) return out;
    const rows = this.sql
      .exec(
        "SELECT idx, z, data FROM zblocks WHERE path = ? AND idx BETWEEN ? AND ? ORDER BY idx",
        path,
        Math.floor(start / BLOCK),
        Math.floor((end - 1) / BLOCK),
      )
      .toArray();
    for (const { idx, z, data } of rows) {
      const block = z ? await inflate(new Uint8Array(data)) : new Uint8Array(data);
      const blockStart = Number(idx) * BLOCK;
      const from = Math.max(start, blockStart);
      const to = Math.min(end, blockStart + block.length);
      if (to > from) out.set(block.subarray(from - blockStart, to - blockStart), from - start);
    }
    return out;
  }
}

export default {
  fetch(request, env) {
    return env.STORE.get(env.STORE.idFromName("packages")).fetch(request);
  },
};
