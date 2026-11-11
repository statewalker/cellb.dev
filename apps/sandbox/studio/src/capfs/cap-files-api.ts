// Vendored from statewalker-sandbox/apps/flue-capfs-do (2641939, 2026-11-11); changes marked "studio:".
// A @statewalker/webrun-files FilesApi over a capability: what a holder (an agent, a tool, a
// sub-agent) uses to read and write files of any size as streams. Content moves in chunks over
// the capability's own transport (an RPC stub, or the token through Workspace.fsCall), because
// neither carries a ReadableStream on every runtime: Durable Object RPC refuses streams on cellb
// and celld. A stream is a server-side id; every chunk is an ordinary capability call,
// authorized again, so a revocation stops a stream between two chunks.
//
//   read(path)   openRead → readChunk … (empty chunk: the end) → closeRead
//   write(path)  openWrite → writeChunk … → commitWrite (abortWrite on failure); the file
//                changes at commit, all at once

import type { FilesApi, ListOptions, ReadOptions } from "@statewalker/webrun-files";
import { type FileInfo, type FileStats, listInPathOrder } from "@statewalker/webrun-files";
import type { Cap } from "./caps.ts";
import type { DirEntryStat } from "./store-types.ts";

/** Bytes per chunk: one store block. */
export const CHUNK_BYTES = 1024 * 1024;

const codeOf = (e: unknown) =>
  (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(String((e as Error)?.message ?? e))?.[1];
const toBytes = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));
const norm = (p: string) => `/${String(p).split("/").filter(Boolean).join("/")}`;
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

export class CapFilesApi implements FilesApi {
  #cap: Cap;
  constructor(cap: Cap) {
    this.#cap = cap;
  }

  async *read(path: string, options: ReadOptions = {}): AsyncIterable<Uint8Array> {
    const p = norm(path);
    let id: string;
    try {
      ({ id } = (await this.#cap.call("openRead", p, {
        start: options.start,
        length: options.length,
      })) as { id: string });
    } catch (e) {
      // FilesApi: a file that does not exist (or a directory) reads as nothing.
      if (codeOf(e) === "ENOENT" || codeOf(e) === "EISDIR") return;
      throw e;
    }
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const chunk = toBytes(await this.#cap.call("readChunk", p, id, CHUNK_BYTES));
        if (!chunk.length) return;
        yield chunk;
      }
    } finally {
      await this.#cap.call("closeRead", p, id).catch(() => {});
    }
  }

  async write(
    path: string,
    content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const p = norm(path);
    const { id } = (await this.#cap.call("openWrite", p, {})) as { id: string };
    try {
      for await (const chunk of content as AsyncIterable<Uint8Array>) {
        const b = toBytes(chunk);
        for (let at = 0; at < b.length; at += CHUNK_BYTES) {
          // Exactly these bytes: RPC copies a view's whole buffer.
          await this.#cap.call("writeChunk", p, id, b.slice(at, at + CHUNK_BYTES));
        }
      }
      await this.#cap.call("commitWrite", p, id);
    } catch (e) {
      await this.#cap.call("abortWrite", p, id).catch(() => {});
      throw e;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.#cap.call("mkdir", norm(path), { recursive: true });
  }

  async *list(path: string, options: ListOptions = {}): AsyncIterable<FileInfo> {
    const root = norm(path);
    const st = await this.stats(root);
    if (st?.kind !== "directory") return;
    const children = async (dir: string): Promise<FileInfo[]> => {
      let entries: DirEntryStat[];
      try {
        entries = (await this.#cap.call("readdirStat", dir)) as DirEntryStat[];
      } catch {
        return []; // a directory the token cannot list shows as empty
      }
      return entries.map((e) =>
        e.isDirectory
          ? { kind: "directory", name: e.name, path: join(dir, e.name) }
          : {
              kind: "file",
              name: e.name,
              path: join(dir, e.name),
              size: e.size,
              lastModified: Date.parse(e.mtime) || 0,
            },
      );
    };
    yield* listInPathOrder(root, children, options);
  }

  async stats(path: string): Promise<FileStats | undefined> {
    try {
      const s = (await this.#cap.call("stat", norm(path))) as {
        isDirectory: boolean;
        size: number;
        mtime: string;
      };
      return s.isDirectory
        ? { kind: "directory" }
        : { kind: "file", size: s.size, lastModified: Date.parse(s.mtime) || 0 };
    } catch (e) {
      if (codeOf(e) === "ENOENT") return undefined;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stats(path)) !== undefined;
  }

  async remove(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false;
    await this.#cap.call("rm", norm(path), { recursive: true });
    return true;
  }

  /**
   * `target` is the exact new path (FilesApi), not a directory to move into as with `mv`: what is
   * at `target` is replaced.
   */
  async move(source: string, target: string): Promise<boolean> {
    return this.#transfer("mv", source, target);
  }

  async copy(source: string, target: string): Promise<boolean> {
    return this.#transfer("cp", source, target);
  }

  async #transfer(kind: "cp" | "mv", source: string, target: string): Promise<boolean> {
    const from = norm(source);
    const to = norm(target);
    if (!(await this.exists(from))) return false;
    if (from === to) return true;
    if (await this.exists(to)) await this.#cap.call("rm", to, { recursive: true });
    await this.#cap.move(kind, from, to, { recursive: true });
    return true;
  }
}
