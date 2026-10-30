/**
 * The FilesApi the LTX store needs (exists, stats, list, read with ranges, write, remove, move)
 * on OPFS through SyncAccessHandles: for a worker that alone owns its directory (the LTX store
 * worker). A write is one synchronous `write()` per chunk into a fresh handle, against a
 * `createWritable()` stream (a swap file, then a copy) in the asynchronous API.
 */
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";

type Dir = FileSystemDirectoryHandle;
type SyncHandle = {
  read(b: Uint8Array, o: { at: number }): number;
  write(b: Uint8Array, o: { at: number }): number;
  getSize(): number;
  truncate(n: number): void;
  flush(): void;
  close(): void;
};

/** Time spent per step of writes (ms), for traces. */
export const opfsSyncWriteStats = {
  writes: 0,
  lookupMs: 0,
  openMs: 0,
  writeMs: 0,
  flushMs: 0,
  closeMs: 0,
};

export function opfsSyncFiles(root: Dir): FilesApi {
  const parts = (path: string) => path.split("/").filter(Boolean);
  const dirOf = async (segs: string[], create: boolean): Promise<Dir | undefined> => {
    let d = root;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s, { create });
      } catch {
        return undefined;
      }
    }
    return d;
  };
  const fileOf = async (path: string, create = false) => {
    const p = parts(path);
    const d = await dirOf(p.slice(0, -1), create);
    if (!d || !p.length) return undefined;
    try {
      return await d.getFileHandle(p[p.length - 1], { create });
    } catch {
      return undefined;
    }
  };
  const sync = (f: FileSystemFileHandle) =>
    (f as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();

  const api: Partial<FilesApi> = {
    async exists(path) {
      return !!(await fileOf(path)) || !!(await dirOf(parts(path), false));
    },
    async stats(path) {
      const f = await fileOf(path);
      if (f) {
        const file = await f.getFile();
        return { kind: "file", size: file.size, lastModified: file.lastModified };
      }
      return (await dirOf(parts(path), false)) ? { kind: "directory" } : undefined;
    },
    async *list(path) {
      const d = await dirOf(parts(path), false);
      if (!d) return;
      const base = `/${parts(path).join("/")}`.replace(/\/$/, "");
      const out: FileInfo[] = [];
      for await (const [name, h] of (
        d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
      ).entries()) {
        const p = `${base}/${name}`;
        if (h.kind === "file") {
          const file = await (h as FileSystemFileHandle).getFile();
          out.push({
            kind: "file",
            name,
            path: p,
            size: file.size,
            lastModified: file.lastModified,
          });
        } else out.push({ kind: "directory", name, path: p });
      }
      out.sort((a, b) => (a.name < b.name ? -1 : 1));
      yield* out;
    },
    async *read(path, o) {
      const f = await fileOf(path);
      if (!f) return;
      // Reads go through the File snapshot (no exclusive handle needed).
      const file = await f.getFile();
      const start = o?.start ?? 0;
      const end = o?.length !== undefined ? Math.min(file.size, start + o.length) : file.size;
      if (end > start) yield new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
    async write(path, content) {
      const st = opfsSyncWriteStats;
      let t = performance.now();
      const f = (await fileOf(path, true)) as FileSystemFileHandle;
      st.lookupMs += performance.now() - t;
      t = performance.now();
      const h = await sync(f);
      st.openMs += performance.now() - t;
      try {
        h.truncate(0);
        let at = 0;
        t = performance.now();
        for await (const c of content as AsyncIterable<Uint8Array>) at += h.write(c, { at });
        st.writeMs += performance.now() - t;
        t = performance.now();
        h.flush();
        st.flushMs += performance.now() - t;
      } finally {
        t = performance.now();
        h.close();
        st.closeMs += performance.now() - t;
        st.writes++;
      }
    },
    async remove(path) {
      const p = parts(path);
      const d = await dirOf(p.slice(0, -1), false);
      if (!d) return false;
      try {
        await d.removeEntry(p[p.length - 1], { recursive: true });
        return true;
      } catch {
        return false;
      }
    },
    async move(source, target) {
      const f = (await fileOf(source)) as FileSystemFileHandle & {
        move?: (d: Dir, n: string) => Promise<void>;
      };
      if (!f) return false;
      const t = parts(target);
      const d = (await dirOf(t.slice(0, -1), true)) as Dir;
      if (f.move) await f.move(d, t[t.length - 1]);
      else {
        await api.write?.(target, api.read?.(source) as AsyncIterable<Uint8Array>);
        await api.remove?.(source);
      }
      return true;
    },
    async mkdir(path) {
      await dirOf(parts(path), true);
    },
  };
  return api as FilesApi;
}
