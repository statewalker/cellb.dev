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

/** A write the origin's storage quota refused: what was written, and what the quota allows. */
export class StorageQuotaError extends Error {
  name = "QuotaExceededError";
}

function quotaError(path: string, at: number, wrote?: number, of?: number): StorageQuotaError {
  return new StorageQuotaError(
    `storage quota exceeded writing ${path} (${Math.round(at / 1e6)} MB written${wrote !== undefined ? `; the last write took ${wrote} of ${of} bytes` : ""}): free space in this origin's storage`,
  );
}

export function opfsSyncFiles(root: Dir): FilesApi {
  const parts = (path: string) => path.split("/").filter(Boolean);
  /** "Not there" is undefined; any other failure (quota, state, security) is thrown as is. */
  const absent = (err: unknown) => {
    const name = (err as DOMException)?.name;
    if (name === "NotFoundError" || name === "TypeMismatchError") return undefined;
    throw err;
  };
  const dirOf = async (segs: string[], create: boolean): Promise<Dir | undefined> => {
    let d = root;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s, { create });
      } catch (err) {
        return absent(err);
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
    } catch (err) {
      return absent(err);
    }
  };
  /** `f` renamed to `to`, replacing a file there. */
  const moveInto = async (f: FileSystemFileHandle, to: string) => {
    const t = parts(to);
    const d = await dirOf(t.slice(0, -1), true);
    if (!d) throw new Error(`opfs: cannot create the directory of ${to}`);
    const movable = f as FileSystemFileHandle & { move?: (d: Dir, n: string) => Promise<void> };
    if (!movable.move) throw new Error("opfs: FileSystemHandle.move() is not supported");
    try {
      await movable.move(d, t[t.length - 1]);
    } catch (err) {
      // Where a move does not replace an existing file: remove it, then move.
      if ((err as DOMException)?.name !== "InvalidModificationError") throw err;
      await d.removeEntry(t[t.length - 1]);
      await movable.move(d, t[t.length - 1]);
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
      // Into a temporary file, moved into place once complete: a reader never sees a partial
      // file, and a failed write (quota) leaves nothing behind under `path`.
      const st = opfsSyncWriteStats;
      const p = parts(path);
      const tmp = `/${[...p.slice(0, -1), `${p[p.length - 1]}.part-${Math.random().toString(36).slice(2, 10)}`].join("/")}`;
      let t = performance.now();
      const f = await fileOf(tmp, true);
      if (!f) throw new Error(`opfs: cannot create ${tmp}`);
      st.lookupMs += performance.now() - t;
      t = performance.now();
      const h = await sync(f);
      st.openMs += performance.now() - t;
      let at = 0;
      try {
        try {
          t = performance.now();
          for await (const c of content as AsyncIterable<Uint8Array>) {
            const n = h.write(c, { at });
            // Past the quota, Chromium's SyncAccessHandle does not throw: write() returns an
            // error code as an unsigned count (4294967288 = -8), or a short count. Adding it to
            // the offset put the next chunk gigabytes past the end of the file.
            if (n !== c.length) throw quotaError(path, at, n, c.length);
            at += n;
          }
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
        await moveInto(f, path);
      } catch (err) {
        await api.remove?.(tmp).catch(() => false);
        if ((err as DOMException)?.name === "QuotaExceededError") throw quotaError(path, at);
        throw err;
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
      const f = await fileOf(source);
      if (!f) return false;
      await moveInto(f, target);
      return true;
    },
    async mkdir(path) {
      await dirOf(parts(path), true);
    },
  };
  return api as FilesApi;
}
