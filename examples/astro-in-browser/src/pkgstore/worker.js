// The package store: ONE Durable Object that owns the persistence of npm packages (each a
// "pack", see ../builder/package-cache.ts) and small JSON documents (version index, locks).
// Every other worker (the builder, the download workers) reads and writes through HTTP, so
// no other realm opens the storage: the DO's own SQLite (ctx.storage.sql), on OPFS under cellb
// in a browser, or Cloudflare's in production.
//
//   PUT  …/files/<path>     body → stored in 256 KiB blocks         → 204
//   GET  …/files/<path>     Range: bytes=a-b supported             → 200 / 206 / 404
//   HEAD …/files/<path>                                             → 200 (Content-Length) / 404
//
// Plain JavaScript with no imports: the runtime provides the DurableObject base class (cellb's
// browser realm: globalThis.__cellsWorkersModule; the module stays valid for workerd, where
// `cloudflare:workers` would be imported instead).
const { DurableObject } = globalThis.__cellsWorkersModule;

const BLOCK = 256 * 1024;

export class PackageStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS blocks (path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))",
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const at = url.pathname.indexOf("/files/");
    if (at < 0) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(url.pathname.slice(at + "/files".length));
    if (request.method === "PUT") return this.put(path, new Uint8Array(await request.arrayBuffer()));
    const row = this.sql.exec("SELECT size FROM files WHERE path = ?", path).toArray()[0];
    if (!row) return new Response(null, { status: 404 });
    const size = Number(row.size);
    if (request.method === "HEAD") return new Response(null, { headers: { "content-length": String(size) } });
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const start = range ? Math.min(Number(range[1]), size) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]) + 1, size) : size;
    const body = this.slice(path, start, end);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        "content-length": String(body.length),
        ...(range ? { "content-range": `bytes ${start}-${end - 1}/${size}` } : {}),
      },
    });
  }

  put(path, bytes) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM blocks WHERE path = ?", path);
      for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += BLOCK, idx++)
        this.sql.exec("INSERT INTO blocks (path, idx, data) VALUES (?, ?, ?)", path, idx, bytes.subarray(i, i + BLOCK));
      this.sql.exec("INSERT OR REPLACE INTO files (path, size) VALUES (?, ?)", path, bytes.length);
    });
    return new Response(null, { status: 204 });
  }

  /** Bytes [start, end) of a file: only the blocks the range covers are read. */
  slice(path, start, end) {
    const out = new Uint8Array(Math.max(0, end - start));
    if (!out.length) return out;
    const rows = this.sql
      .exec("SELECT idx, data FROM blocks WHERE path = ? AND idx BETWEEN ? AND ? ORDER BY idx", path, Math.floor(start / BLOCK), Math.floor((end - 1) / BLOCK))
      .toArray();
    for (const { idx, data } of rows) {
      const block = new Uint8Array(data);
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
