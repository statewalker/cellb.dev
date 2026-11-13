// studio: the store the capability gate (FsGate) works on, over ANY @statewalker/webrun-files
// FilesApi: the folder on disk (BrowserFilesApi), memory, OPFS, S3, a Node directory, a Durable
// Object's SQLite (SqlFilesApi), or a CompositeFilesApi of them. It gives FsGate the method
// surface of flue-capfs-do's SqlFs (POSIX-like errors, stat shapes, streams by id), so the gate
// and its Datalog checks stay as they are: the capability filters the real files, not a copy.
//
// What a FilesApi cannot express is approximated: appends read then write (not atomic), chmod
// and utimes change nothing, inode numbers are stable per path in this process only.

import type { FilesApi } from "@statewalker/webrun-files";
import { type FsError, fsError, normalise } from "./path.ts";
import type { DirEntryStat, Entry, PlainStat } from "./store-types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** Bytes as a store keeps them: any view or buffer, copied; a string as UTF-8. */
function bytesOf(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (typeof d === "string") return enc.encode(d);
  if (d && typeof d === "object" && Array.isArray((d as { data?: unknown }).data))
    return Uint8Array.from((d as { data: number[] }).data);
  throw fsError("EINVAL", "content must be bytes or a string");
}

async function readAll(fs: FilesApi, path: string, start?: number, length?: number) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of fs.read(path, { start, length })) {
    parts.push(chunk);
    size += chunk.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const STREAM_IDLE_MS = 2 * 60_000;
const MAX_STREAMS_PER_OWNER = 16;

interface ReadStream {
  kind: "read";
  owner: string;
  path: string;
  pos: number;
  end: number;
  at: number;
}
interface WriteStream {
  kind: "write";
  owner: string;
  path: string;
  parts: Uint8Array[];
  size: number;
  at: number;
}

export class FilesStore {
  readonly fs: FilesApi;
  #ino = new Map<string, number>();
  #streams = new Map<string, ReadStream | WriteStream>();

  constructor(fs: FilesApi) {
    this.fs = fs;
  }

  #inode(path: string) {
    let n = this.#ino.get(path);
    if (!n) {
      n = this.#ino.size + 2;
      this.#ino.set(path, n);
    }
    return n;
  }

  async #kind(path: string): Promise<"file" | "dir" | undefined> {
    if (path === "/") return "dir";
    const s = await this.fs.stats(path);
    return s ? (s.kind === "directory" ? "dir" : "file") : undefined;
  }

  async #mustFile(path: string, syscall: string): Promise<void> {
    const k = await this.#kind(path);
    if (!k) throw fsError("ENOENT", `no such file or directory, ${syscall} '${path}'`);
    if (k === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, ${syscall} '${path}'`);
  }

  async #mustDir(path: string, syscall: string): Promise<void> {
    const k = await this.#kind(path);
    if (!k) throw fsError("ENOENT", `no such file or directory, ${syscall} '${path}'`);
    if (k === "file") throw fsError("ENOTDIR", `not a directory, ${syscall} '${path}'`);
  }

  async #parentIsDir(path: string, syscall: string) {
    const parent = dirname(path);
    if ((await this.#kind(parent)) === "file")
      throw fsError("ENOTDIR", `not a directory, ${syscall} '${parent}'`);
  }

  // ---- what FsGate calls ----

  async missingParents(path: string): Promise<string[]> {
    const out: string[] = [];
    for (let p = dirname(path); p !== "/" && !(await this.#kind(p)); p = dirname(p)) out.unshift(p);
    return out;
  }

  async readFile(path: string): Promise<string> {
    return dec.decode(await this.readFileBuffer(path));
  }
  async readFileBuffer(path: string): Promise<Uint8Array> {
    await this.#mustFile(path, "open");
    return readAll(this.fs, path);
  }
  async writeFile(path: string, data: string): Promise<void> {
    await this.#write(path, enc.encode(String(data ?? "")));
  }
  async writeFileBuffer(path: string, data: unknown): Promise<void> {
    await this.#write(path, bytesOf(data));
  }
  async appendFile(path: string, data: string): Promise<void> {
    await this.#append(path, enc.encode(String(data ?? "")));
  }
  async appendFileBuffer(path: string, data: unknown): Promise<void> {
    await this.#append(path, bytesOf(data));
  }
  async #write(path: string, bytes: Uint8Array) {
    if (path === "/" || (await this.#kind(path)) === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, open '${path}'`);
    await this.#parentIsDir(path, "open");
    await this.fs.write(path, [bytes]);
  }
  async #append(path: string, more: Uint8Array) {
    const k = await this.#kind(path);
    if (k === "dir") throw fsError("EISDIR", `illegal operation on a directory, open '${path}'`);
    const before = k ? await readAll(this.fs, path) : new Uint8Array();
    const all = new Uint8Array(before.length + more.length);
    all.set(before);
    all.set(more, before.length);
    await this.#write(path, all);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#kind(path)) !== undefined;
  }
  async stat(path: string): Promise<PlainStat> {
    if (path === "/")
      return {
        ino: 1,
        dev: 1,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        size: 0,
        mode: 0o755,
        mtime: new Date(0).toISOString(),
      };
    const s = await this.fs.stats(path);
    if (!s) throw fsError("ENOENT", `no such file or directory, stat '${path}'`);
    const dir = s.kind === "directory";
    return {
      ino: this.#inode(path),
      dev: 1,
      isFile: !dir,
      isDirectory: dir,
      isSymbolicLink: false,
      size: dir ? 0 : (s.size ?? 0),
      mode: dir ? 0o755 : 0o644,
      mtime: new Date(s.kind === "file" ? (s.lastModified ?? 0) : 0).toISOString(),
    };
  }
  lstat(path: string) {
    return this.stat(path);
  }
  async realpath(path: string): Promise<string> {
    if (!(await this.exists(path)))
      throw fsError("ENOENT", `no such file or directory, realpath '${path}'`);
    return normalise(path);
  }
  async readdir(path: string): Promise<string[]> {
    return (await this.readdirStat(path)).map((e) => e.name);
  }
  async readdirStat(path: string): Promise<DirEntryStat[]> {
    await this.#mustDir(path, "scandir");
    const out: DirEntryStat[] = [];
    for await (const e of this.fs.list(path)) {
      out.push({
        name: e.name,
        isDirectory: e.kind === "directory",
        size: e.kind === "directory" ? 0 : (e.size ?? 0),
        mtime: new Date(e.kind === "file" ? (e.lastModified ?? 0) : 0).toISOString(),
      });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const k = await this.#kind(path);
    if (k === "dir") {
      if (opts?.recursive) return;
      throw fsError("EEXIST", `file already exists, mkdir '${path}'`);
    }
    if (k === "file") throw fsError("EEXIST", `file already exists, mkdir '${path}'`);
    if (!opts?.recursive) {
      const parent = await this.#kind(dirname(path));
      if (!parent) throw fsError("ENOENT", `no such file or directory, mkdir '${path}'`);
      if (parent === "file") throw fsError("ENOTDIR", `not a directory, mkdir '${path}'`);
    }
    await this.fs.mkdir(path);
  }
  async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (path === "/") throw fsError("EPERM", "cannot remove '/'");
    const k = await this.#kind(path);
    if (!k) {
      if (opts?.force) return;
      throw fsError("ENOENT", `no such file or directory, rm '${path}'`);
    }
    if (k === "dir" && !opts?.recursive) {
      for await (const _ of this.fs.list(path))
        throw fsError("ENOTEMPTY", `directory not empty, rm '${path}'`);
    }
    await this.fs.remove(path);
  }
  async chmod(path: string): Promise<void> {
    if (!(await this.exists(path)))
      throw fsError("ENOENT", `no such file or directory, chmod '${path}'`);
  }
  async utimes(path: string): Promise<void> {
    if (!(await this.exists(path)))
      throw fsError("ENOENT", `no such file or directory, utime '${path}'`);
  }

  /** The entry and everything below it (a directory first, then its subtree), as SqlFs gives. */
  async entries(path: string): Promise<Entry[]> {
    const k = await this.#kind(path);
    if (!k) throw fsError("ENOENT", `no such file or directory '${path}'`);
    if (k === "file") return [{ path, kind: "file" }];
    const out: Entry[] = [{ path, kind: "dir" }];
    for await (const e of this.fs.list(path, { recursive: true }))
      out.push({ path: normalise(e.path), kind: e.kind === "directory" ? "dir" : "file" });
    return out;
  }
  async resolveTarget(src: string, dst: string): Promise<string> {
    return (await this.#kind(dst)) === "dir" ? join(dst, basename(src)) : dst;
  }
  async cp(src: string, dst: string, opts?: { recursive?: boolean }): Promise<void> {
    const k = await this.#kind(src);
    if (!k) throw fsError("ENOENT", `no such file or directory, cp '${src}'`);
    if (k === "dir" && !opts?.recursive)
      throw fsError("EISDIR", `-r not specified; omitting directory '${src}'`);
    if (await this.exists(dst)) await this.fs.remove(dst);
    await this.fs.copy(src, dst);
  }
  async mv(src: string, dst: string): Promise<void> {
    if (src === dst) return;
    if (!(await this.exists(src)))
      throw fsError("ENOENT", `no such file or directory, rename '${src}'`);
    if (dst.startsWith(`${src}/`)) throw fsError("EINVAL", `cannot move '${src}' into itself`);
    if (await this.exists(dst)) await this.fs.remove(dst);
    await this.fs.move(src, dst);
  }

  // ---- streams (chunks of any size, each authorized again by FsGate) ----

  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.#streams) if (now - s.at > STREAM_IDLE_MS) this.#streams.delete(id);
  }
  #room(owner: string) {
    this.#sweep();
    let n = 0;
    for (const s of this.#streams.values()) if (s.owner === owner) n++;
    if (n >= MAX_STREAMS_PER_OWNER) throw fsError("EMFILE", "too many open streams");
  }
  #own<T extends ReadStream | WriteStream>(
    id: unknown,
    path: string,
    owner: string,
    kind: T["kind"],
  ): T {
    const s = this.#streams.get(String(id));
    if (!s || s.kind !== kind || s.owner !== owner || s.path !== path)
      throw fsError("EBADF", `bad stream '${String(id)}'`);
    s.at = Date.now();
    return s as T;
  }

  async openRead(path: string, opts: { start?: number; length?: number } = {}, owner: string) {
    const s = await this.stat(path);
    if (s.isDirectory) throw fsError("EISDIR", `illegal operation on a directory, open '${path}'`);
    this.#room(owner);
    const start = Math.max(0, Math.min(Number(opts.start ?? 0) || 0, s.size));
    const end =
      opts.length === undefined
        ? s.size
        : Math.min(s.size, start + Math.max(0, Number(opts.length) || 0));
    const id = crypto.randomUUID();
    this.#streams.set(id, { kind: "read", owner, path, pos: start, end, at: Date.now() });
    return { id, size: s.size };
  }
  async readChunk(path: string, id: unknown, max: unknown, owner: string): Promise<Uint8Array> {
    const s = this.#own<ReadStream>(id, path, owner, "read");
    const n = Math.min(Math.max(1, Number(max) || 1), s.end - s.pos);
    if (n <= 0) return new Uint8Array();
    const bytes = await readAll(this.fs, path, s.pos, n);
    s.pos += bytes.length;
    return bytes;
  }
  async closeRead(path: string, id: unknown, owner: string): Promise<void> {
    this.#own<ReadStream>(id, path, owner, "read");
    this.#streams.delete(String(id));
  }
  async openWrite(path: string, _opts: unknown, owner: string) {
    if ((await this.#kind(path)) === "dir")
      throw fsError("EISDIR", `illegal operation on a directory, open '${path}'`);
    this.#room(owner);
    const id = crypto.randomUUID();
    this.#streams.set(id, { kind: "write", owner, path, parts: [], size: 0, at: Date.now() });
    return { id };
  }
  async writeChunk(
    path: string,
    id: unknown,
    chunk: unknown,
    owner: string,
  ): Promise<{ size: number }> {
    const s = this.#own<WriteStream>(id, path, owner, "write");
    const b = bytesOf(chunk).slice();
    s.parts.push(b);
    s.size += b.length;
    return { size: s.size };
  }
  async commitWrite(path: string, id: unknown, owner: string): Promise<{ size: number }> {
    const s = this.#own<WriteStream>(id, path, owner, "write");
    this.#streams.delete(String(id));
    await this.#parentIsDir(path, "open");
    await this.fs.write(path, s.parts);
    return { size: s.size };
  }
  async abortWrite(path: string, id: unknown, owner: string): Promise<void> {
    this.#own<WriteStream>(id, path, owner, "write");
    this.#streams.delete(String(id));
  }
}

export type { FsError };
