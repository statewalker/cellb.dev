// Wasmer's host-filesystem protocol served by a FilesApi.
//
// A WASIX guest's calls on a mounted directory arrive as (method, args) with paths relative to the
// mount (see wasmer-sdk js/bindgen/src/host_filesystem.rs). FilesApi writes whole files, so a file
// opened for writing is buffered here and written back on flush, close and sync; reads of files
// nobody is writing go to the FilesApi by range.
//
// Security: the FilesApi given here IS the boundary. Hand in a composite view (CompositeFilesApi,
// FilteredFilesApi, GuardedFilesApi, readOnly from @statewalker/webrun-files-composite): hidden
// paths answer ENOENT, and a refused mutation answers EACCES (fail closed: an error without a code
// from a mutating call is treated as a refusal). Paths that escape the mount are refused here.
import { type FileStats, type FilesApi, readFile, readRange } from "@statewalker/webrun-files";

/** The bridge's largest read or write per call. */
export const CHUNK_BYTES = 65_536;

export type FsErrorCode =
  | "ENOENT"
  | "EEXIST"
  | "EACCES"
  | "ENOTDIR"
  | "EISDIR"
  | "ENOTEMPTY"
  | "EINVAL"
  | "EBADF"
  | "EFBIG"
  | "EIO";

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: FsErrorCode, message: string): never => {
  throw new FsError(code, message);
};

/** `{ code, message }` for the bridge's reply. */
export function filesystemError(error: unknown): { code: string; message: string } {
  const e = error as { code?: unknown; message?: unknown };
  return {
    code: typeof e?.code === "string" ? e.code : "EIO",
    message: String(e?.message ?? error),
  };
}

interface Metadata {
  kind: "file" | "directory";
  size: number;
  accessed?: string;
  modified?: string;
  created?: string;
}

const ns = (ms: number) => (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
function metadata(stats: FileStats, size?: number): Metadata {
  if (stats.kind === "directory") return { kind: "directory", size: 0 };
  const t = ns(stats.lastModified);
  return { kind: "file", size: size ?? stats.size, accessed: t, modified: t, created: t };
}

/** A guest path relative to the mount: "" is the mount's root. */
function relative(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) return fail("EINVAL", "invalid path");
  if (value.startsWith("/")) return fail("EINVAL", `absolute path: ${value}`);
  const parts = value.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) return fail("EACCES", `path escapes the mount: ${value}`);
  return parts.join("/");
}
const absolute = (rel: string) => `/${rel}`;
const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("EINVAL", "invalid offset or size");
  return value as number;
}

/** A file being written: its whole content, shared by every descriptor open on the path. */
class Buffer {
  data: Uint8Array;
  size: number;
  dirty = false;
  refs = 0;
  constructor(
    initial: Uint8Array,
    readonly maxBytes = DEFAULT_MAX_FILE_BYTES,
  ) {
    this.data = initial;
    this.size = initial.length;
  }
  ensure(capacity: number) {
    if (capacity <= this.data.length) return;
    // a guest's write at a huge offset (or ftruncate) would allocate that much on the FilesApi's
    // thread: refuse past the cap
    if (capacity > this.maxBytes) fail("EFBIG", `a file may hold at most ${this.maxBytes} bytes`);
    const next = new Uint8Array(
      Math.min(this.maxBytes, Math.max(capacity, this.data.length * 2, 4096)),
    );
    next.set(this.data.subarray(0, this.size));
    this.data = next;
  }
  setLen(len: number) {
    this.ensure(len);
    if (len > this.size) this.data.fill(0, this.size, len);
    this.size = len;
    this.dirty = true;
  }
  write(offset: number, bytes: Uint8Array) {
    this.ensure(offset + bytes.length);
    if (offset > this.size) this.data.fill(0, this.size, offset);
    this.data.set(bytes, offset);
    this.size = Math.max(this.size, offset + bytes.length);
    this.dirty = true;
  }
  content() {
    return this.data.slice(0, this.size);
  }
}

interface Descriptor {
  path: string;
  read: boolean;
  write: boolean;
  append: boolean;
  buffer?: Buffer;
}

/** The largest file a guest may write through a volume, by default (256 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

export class FilesVolume {
  readonly #files: FilesApi;
  readonly #readOnly: boolean;
  readonly #maxFileBytes: number;
  readonly #descriptors = new Map<number, Descriptor>();
  readonly #buffers = new Map<string, Buffer>();
  #next = 0;

  constructor(files: FilesApi, opts: { readOnly?: boolean; maxFileBytes?: number } = {}) {
    this.#files = files;
    this.#readOnly = !!opts.readOnly;
    this.#maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /** One protocol call. Throws FsError (or an error with a POSIX `code`). */
  async request(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "stat":
        return this.#stat(relative(args[0]));
      case "readDir":
        return this.#readDir(relative(args[0]));
      case "mkdir":
        return this.#mkdir(relative(args[0]));
      case "open":
        return this.#open(
          relative(args[0]),
          ...(args.slice(1, 7).map(Boolean) as [
            boolean,
            boolean,
            boolean,
            boolean,
            boolean,
            boolean,
          ]),
        );
      case "read":
        return this.#read(this.#fd(args[0]), integer(args[1]), integer(args[2]));
      case "write":
        return this.#write(this.#fd(args[0]), integer(args[1]), args[2]);
      case "setLen": {
        const d = this.#fd(args[0]);
        if (!d.buffer) fail("EACCES", "file is not open for writing");
        d.buffer?.setLen(integer(args[1]));
        return null;
      }
      case "fileStat": {
        const d = this.#fd(args[0]);
        const stats = await this.#stats(d.path);
        if (!stats) {
          if (d.buffer) return { kind: "file", size: d.buffer.size };
          return fail("ENOENT", d.path);
        }
        return metadata(stats, d.buffer?.size);
      }
      case "flush":
        await this.#flush(this.#fd(args[0]).buffer, this.#fd(args[0]).path);
        return null;
      case "close":
        return this.#close(integer(args[0]));
      case "sync":
        for (const [path, buffer] of this.#buffers) await this.#flush(buffer, path);
        return null;
      case "remove":
        return this.#remove(relative(args[0]));
      case "rename":
        return this.#rename(relative(args[0]), relative(args[1]));
      case "setTimes":
      case "setFileTimes":
        // FilesApi keeps no settable times; accepted so tools that touch files keep working.
        return null;
      default:
        return fail("EINVAL", `unknown filesystem call: ${method}`);
    }
  }

  // ---- reads ------------------------------------------------------------------------------

  async #stats(rel: string): Promise<FileStats | undefined> {
    try {
      return await this.#files.stats(absolute(rel));
    } catch (e) {
      throw this.#readError(e);
    }
  }

  async #need(rel: string): Promise<FileStats> {
    const stats = await this.#stats(rel);
    if (!stats) {
      // A file created by open() but not yet written back still exists for the guest.
      const b = this.#buffers.get(rel);
      if (b) return { kind: "file", size: b.size, lastModified: Date.now() };
      if (rel === "") return { kind: "directory" };
      return fail("ENOENT", rel);
    }
    return stats;
  }

  async #stat(rel: string) {
    return metadata(await this.#need(rel), this.#buffers.get(rel)?.size);
  }

  async #readDir(rel: string) {
    const stats = await this.#need(rel);
    if (stats.kind !== "directory") fail("ENOTDIR", rel);
    const out: (Metadata & { name: string })[] = [];
    try {
      for await (const entry of this.#files.list(absolute(rel))) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        out.push({ name: entry.name, ...metadata(entry, this.#buffers.get(childRel)?.size) });
      }
    } catch (e) {
      throw this.#readError(e);
    }
    return out;
  }

  async #read(d: Descriptor, offset: number, count: number) {
    if (!d.read) fail("EACCES", "file is not open for reading");
    const n = Math.min(count, CHUNK_BYTES);
    if (d.buffer)
      return d.buffer.data.slice(
        Math.min(offset, d.buffer.size),
        Math.min(offset + n, d.buffer.size),
      );
    const shared = this.#buffers.get(d.path);
    if (shared)
      return shared.data.slice(Math.min(offset, shared.size), Math.min(offset + n, shared.size));
    try {
      return await readRange(this.#files, absolute(d.path), offset, n);
    } catch (e) {
      throw this.#readError(e);
    }
  }

  // ---- writes -----------------------------------------------------------------------------

  #mutable(rel: string) {
    if (this.#readOnly) fail("EACCES", `read-only mount: ${rel}`);
    if (rel === "") fail("EACCES", "cannot change the mount's root");
  }

  async #parentDirectory(rel: string) {
    const parent = await this.#need(parentOf(rel));
    if (parent.kind !== "directory") fail("ENOTDIR", parentOf(rel));
  }

  async #mutate<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof FsError || typeof (e as { code?: unknown })?.code === "string") throw e;
      // Fail closed: the FilesApi (a guard, a read-only or filtered view) refused it.
      throw new FsError("EACCES", (e as Error)?.message ?? String(e));
    }
  }

  async #mkdir(rel: string) {
    this.#mutable(rel);
    await this.#parentDirectory(rel);
    if (await this.#stats(rel)) fail("EEXIST", rel);
    await this.#mutate(() => this.#files.mkdir(absolute(rel)));
    return null;
  }

  async #open(
    rel: string,
    read: boolean,
    write: boolean,
    create: boolean,
    createNew: boolean,
    truncate: boolean,
    append: boolean,
  ) {
    const writing = write || append || truncate || create || createNew;
    if (writing) this.#mutable(rel);
    await this.#parentDirectory(rel);
    const stats = await this.#stats(rel);
    const existing =
      stats ??
      (this.#buffers.has(rel)
        ? ({ kind: "file", size: 0, lastModified: 0 } as FileStats)
        : undefined);
    if (existing && createNew) fail("EEXIST", rel);
    if (!existing && !create && !createNew) fail("ENOENT", rel);
    if (existing?.kind === "directory") fail("EISDIR", rel);
    if (truncate && !write && !append) fail("EACCES", `truncate without write: ${rel}`);
    const d: Descriptor = { path: rel, read, write: write || append, append };
    if (d.write) {
      let buffer = this.#buffers.get(rel);
      if (!buffer) {
        const initial = existing && !truncate ? await this.#readAll(rel) : new Uint8Array(0);
        buffer = new Buffer(initial, this.#maxFileBytes);
        this.#buffers.set(rel, buffer);
      } else if (truncate) buffer.setLen(0);
      // Write back at the first open for writing: a write the FilesApi refuses (a guard, a
      // read-only view) fails here, where every guest checks for errors; at close() it would be
      // lost by guests that never close explicitly. It also puts an O_CREAT file in the FilesApi.
      // Cost: one rewrite of the file per first open for writing.
      if (!existing || truncate || buffer.refs === 0) {
        buffer.dirty = true;
        try {
          await this.#flush(buffer, rel);
        } catch (e) {
          if (buffer.refs === 0) this.#buffers.delete(rel);
          throw e;
        }
      }
      buffer.refs++;
      d.buffer = buffer;
    }
    const id = ++this.#next;
    this.#descriptors.set(id, d);
    return id;
  }

  async #readAll(rel: string) {
    try {
      return await readFile(this.#files, absolute(rel));
    } catch (e) {
      throw this.#readError(e);
    }
  }

  #write(d: Descriptor, offset: number, data: unknown) {
    if (!d.buffer) return fail("EACCES", "file is not open for writing");
    const bytes =
      data instanceof Uint8Array
        ? data
        : Array.isArray(data)
          ? Uint8Array.from(data)
          : fail("EINVAL", "invalid bytes");
    const chunk = bytes.subarray(0, CHUNK_BYTES);
    d.buffer.write(d.append ? d.buffer.size : offset, chunk);
    return chunk.length;
  }

  async #flush(buffer: Buffer | undefined, rel: string) {
    if (!buffer?.dirty) return;
    const content = buffer.content();
    await this.#mutate(() => this.#files.write(absolute(rel), [content]));
    buffer.dirty = false;
  }

  async #close(id: number) {
    const d = this.#descriptors.get(id);
    if (!d) return fail("EBADF", "file is closed");
    this.#descriptors.delete(id);
    if (d.buffer) {
      d.buffer.refs--;
      try {
        await this.#flush(d.buffer, d.path);
      } finally {
        if (d.buffer.refs <= 0 && this.#buffers.get(d.path) === d.buffer)
          this.#buffers.delete(d.path);
      }
    }
    return null;
  }

  async #remove(rel: string) {
    this.#mutable(rel);
    const stats = await this.#need(rel);
    if (stats.kind === "directory") {
      for await (const _ of this.#files.list(absolute(rel))) fail("ENOTEMPTY", rel);
    }
    this.#buffers.delete(rel);
    await this.#mutate(() => this.#files.remove(absolute(rel)));
    return null;
  }

  async #rename(from: string, to: string) {
    this.#mutable(from);
    this.#mutable(to);
    const source = await this.#need(from);
    await this.#parentDirectory(to);
    if (from === to) return null;
    if (to.startsWith(`${from}/`)) fail("EINVAL", "cannot move a directory into itself");
    const buffer = this.#buffers.get(from);
    await this.#flush(buffer, from);
    const target = await this.#stats(to);
    if (target) {
      if (target.kind !== source.kind) fail(target.kind === "directory" ? "EISDIR" : "ENOTDIR", to);
      if (target.kind === "directory")
        for await (const _ of this.#files.list(absolute(to))) fail("ENOTEMPTY", to);
      await this.#mutate(() => this.#files.remove(absolute(to)));
    }
    await this.#mutate(() => this.#files.move(absolute(from), absolute(to)));
    if (buffer) {
      this.#buffers.delete(from);
      this.#buffers.set(to, buffer);
      for (const d of this.#descriptors.values()) if (d.path === from) d.path = to;
    }
    return null;
  }

  #fd(value: unknown): Descriptor {
    const d = this.#descriptors.get(integer(value));
    if (!d) return fail("EBADF", "file is closed");
    return d;
  }

  #readError(e: unknown) {
    if (e instanceof FsError || typeof (e as { code?: unknown })?.code === "string") return e;
    return new FsError("EIO", (e as Error)?.message ?? String(e));
  }
}
