/**
 * The FilesApi the package cache needs (exists, stats, read with ranges, write), over HTTP to
 * the package store (src/pkgstore/worker.js): any worker can read and write packages while
 * only the store's Durable Object touches storage.
 *
 * Packs never change once written, so reads go through an LRU cache of aligned 256 KiB blocks
 * (`budget` bytes, 64 MiB by default): the many small files of a pack cost one request per
 * block, not one per file, and memory stays bounded.
 */
import type { FilesApi } from "@statewalker/webrun-files";

const BLOCK = 256 * 1024;

export function httpFiles(base: string, budget = 16 * 1024 * 1024): FilesApi {
  const url = (path: string) =>
    `${base.replace(/\/$/, "")}/files${path.startsWith("/") ? path : `/${path}`}`;
  const sizes = new Map<string, number | undefined>();
  const size = async (path: string) => {
    if (sizes.has(path)) return sizes.get(path);
    const r = await fetch(url(path), { method: "HEAD" });
    const n = r.ok ? Number(r.headers.get("content-length") ?? 0) : undefined;
    if (n !== undefined) sizes.set(path, n); // a missing file may be written later
    return n;
  };
  const blocks = new Map<string, Promise<Uint8Array>>();
  let held = 0;
  const block = (path: string, idx: number, total: number): Promise<Uint8Array> => {
    const key = `${path}#${idx}`;
    const hit = blocks.get(key);
    if (hit) {
      blocks.delete(key); // most recently used last
      blocks.set(key, hit);
      return hit;
    }
    const start = idx * BLOCK;
    const end = Math.min(start + BLOCK, total) - 1;
    const p = fetch(url(path), { headers: { range: `bytes=${start}-${end}` } }).then(async (r) => {
      if (!r.ok)
        throw new Error(
          `package store: GET ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`,
        );
      const b = new Uint8Array(await r.arrayBuffer());
      held += b.length;
      for (const [k, v] of blocks) {
        if (held <= budget) break;
        blocks.delete(k);
        held -= (await v).length;
      }
      return b;
    });
    p.catch(() => blocks.delete(key));
    blocks.set(key, p);
    return p;
  };
  const api: Partial<FilesApi> = {
    async *read(path, o) {
      const total = await size(path);
      if (total === undefined) return;
      const start = Math.min(o?.start ?? 0, total);
      const end = Math.min(o?.length !== undefined ? start + o.length : total, total);
      for (let at = start; at < end; ) {
        const idx = Math.floor(at / BLOCK);
        const b = await block(path, idx, total);
        const from = at - idx * BLOCK;
        const to = Math.min(b.length, end - idx * BLOCK);
        yield b.slice(from, to);
        at = idx * BLOCK + to;
      }
    },
    async write(path, content) {
      const chunks: Uint8Array[] = [];
      for await (const c of content as AsyncIterable<Uint8Array>) chunks.push(c);
      const r = await fetch(url(path), { method: "PUT", body: new Blob(chunks as BlobPart[]) });
      if (!r.ok) throw new Error(`package store: PUT ${path} → ${r.status}`);
      sizes.delete(path);
      for (const k of [...blocks.keys()]) if (k.startsWith(`${path}#`)) blocks.delete(k);
    },
    exists: async (path) => (await size(path)) !== undefined,
    async stats(path) {
      const n = await size(path);
      return n === undefined ? undefined : { kind: "file", size: n, lastModified: 0 };
    },
    mkdir: async () => {},
    async *list() {},
    remove: async () => false,
  };
  return api as FilesApi;
}
