/**
 * A FilesApi across threads: `serveFilesApi(port, files)` answers on one end of a MessagePort
 * for a FilesApi that lives in this thread (the user's own: File System Access, memory, OPFS,
 * a key/value store, S3…), and `rpcFilesClient(port)` is that FilesApi in another thread (the
 * LTX store worker, say). An instance cannot be posted to a worker; a port can.
 *
 * On @statewalker/webrun-rpc: the unary methods are one `callPort` each; a ranged read (the
 * LTX store's page reads) is one `callPort` answered with the bytes; `read` without a length,
 * `list` and `write` stream with `callBidi`. A write is sent in batches of up to `batchBytes`
 * (the LTX encoder yields one small block per page).
 *
 * The client must not live in a thread that blocks on `Atomics.wait` (the SQLite VFS worker):
 * a blocked thread receives no answers.
 */
import type {
  FileInfo,
  FileStats,
  FilesApi,
  ListOptions,
  ReadOptions,
} from "@statewalker/webrun-files";
import {
  callBidi,
  callPort,
  listenBidi,
  listenPort,
  type MessageTarget,
} from "@statewalker/webrun-rpc";

const UNARY = "webrun-files:unary";
const UNARY_METHODS = ["stats", "exists", "mkdir", "remove", "move", "copy", "readRange"] as const;
type UnaryMethod = (typeof UNARY_METHODS)[number];

interface UnaryRequest {
  m: UnaryMethod;
  a: unknown[];
}
interface StreamRequest {
  fs: "read" | "list" | "write";
  path: string;
  opts?: { start?: number; length?: number; recursive?: boolean; after?: string };
}

export interface FilesRpcOptions {
  /** How long one call may take, in ms (a disk, a network store); 60 s by default. */
  timeout?: number;
}

const start = (port: MessageTarget) => (port as { start?: () => void }).start?.();

async function concat(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) parts.push(c), (n += c.length);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

/**
 * Answers `rpcFilesClient` calls on `port` with `files`. Several ports may serve one FilesApi
 * (one per worker). Returns the teardown.
 */
export function serveFilesApi(port: MessageTarget, files: FilesApi): () => void {
  const offUnary = listenPort<UnaryRequest, unknown>(
    port,
    async ({ m, a }) => {
      if (!UNARY_METHODS.includes(m)) throw new Error(`files-rpc: unknown method ${String(m)}`);
      if (m === "readRange") {
        const [path, start, length] = a as [string, number, number];
        return concat(files.read(path, { start, length }));
      }
      return (files[m] as (...args: unknown[]) => Promise<unknown>).apply(files, a);
    },
    { channelName: UNARY },
  );
  const offStream = listenBidi<Uint8Array, unknown>(
    port,
    async (input, params) => {
      const { fs, path, opts } = params as unknown as StreamRequest;
      if (fs === "read") return files.read(path, opts as ReadOptions);
      if (fs === "list") return files.list(path, opts as ListOptions);
      await files.write(path, input);
      return (async function* () {})();
    },
    (params) => typeof (params as { fs?: unknown }).fs === "string",
  );
  start(port);
  return () => {
    offUnary();
    offStream();
  };
}

/** A FilesApi whose calls go over `port` to a `serveFilesApi`. */
export function rpcFilesClient(
  port: MessageTarget,
  opts: FilesRpcOptions & {
    /** Bytes of a write sent per message; 1 MiB by default. */
    batchBytes?: number;
  } = {},
): FilesApi {
  start(port);
  const timeout = opts.timeout ?? 60_000;
  const batchBytes = opts.batchBytes ?? 1 << 20;
  const unary =
    <T>(m: UnaryMethod) =>
    (...a: unknown[]) =>
      callPort<T, UnaryRequest>(port, { m, a }, { channelName: UNARY, timeout });
  const stream = <T>(req: StreamRequest, input: AsyncIterable<Uint8Array> | Uint8Array[] = []) =>
    callBidi<Uint8Array, T>(port, input, {
      ...req,
      options: { timeout, bidiTimeout: 2147483647 },
    });
  /** Chunks gathered into messages of about `batchBytes`. */
  async function* batched(content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
    let parts: Uint8Array[] = [];
    let n = 0;
    const flush = () => {
      const out = parts.length === 1 ? parts[0] : new Uint8Array(n);
      if (parts.length > 1) {
        let o = 0;
        for (const p of parts) out.set(p, o), (o += p.length);
      }
      parts = [];
      n = 0;
      return out;
    };
    for await (const c of content as AsyncIterable<Uint8Array>) {
      if (!c.length) continue;
      parts.push(c);
      n += c.length;
      if (n >= batchBytes) yield flush();
    }
    if (n) yield flush();
  }
  const api: FilesApi = {
    read(path: string, o?: ReadOptions): AsyncIterable<Uint8Array> {
      const { start, length } = o ?? {};
      // A ranged read (the LTX store's page reads): one call, one answer.
      if (length !== undefined)
        return (async function* () {
          const bytes = await unary<Uint8Array>("readRange")(path, start ?? 0, length);
          if (bytes.length) yield bytes;
        })();
      return stream<Uint8Array>({ fs: "read", path, opts: { start } });
    },
    list(path: string, o?: ListOptions): AsyncIterable<FileInfo> {
      return stream<FileInfo>({
        fs: "list",
        path,
        opts: { recursive: o?.recursive, after: o?.after },
      });
    },
    async write(path, content) {
      for await (const _ of stream<never>({ fs: "write", path }, batched(content))) void _;
    },
    stats: unary<FileStats | undefined>("stats") as FilesApi["stats"],
    exists: unary<boolean>("exists") as FilesApi["exists"],
    mkdir: unary<void>("mkdir") as FilesApi["mkdir"],
    remove: unary<boolean>("remove") as FilesApi["remove"],
    move: unary<boolean>("move") as FilesApi["move"],
    copy: unary<boolean>("copy") as FilesApi["copy"],
  };
  return api;
}
