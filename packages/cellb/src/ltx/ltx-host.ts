/**
 * Cells' storage chosen by the app: it opens a FilesApi (File System Access, memory, OPFS, a
 * key/value store, S3…) BEFORE starting cellb's workers, then hands it to them in one of two
 * ways (a FilesApi instance cannot be posted to a worker; a port can):
 *
 * - `filesApiPort(files)`: the FilesApi stays in this thread and is served over a port; the
 *   shard worker passes the port to its LTX store worker (`bucket: { ltx, files: { port } }`),
 *   which runs the store (LZ4, compaction) and calls the FilesApi by message.
 * - `serveLtxStore(files)`: the LTX store itself runs in this thread on the instance (no
 *   FilesApi messages at all); the shard worker's VFS sends it its page reads and commits
 *   (`bucket: { ltx, store: { sab, port } }`). The store's work then shares this thread.
 *
 * Either way, one call per shard worker: a port answers one worker, a store one VFS.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import { serveFilesApi } from "./files-rpc.js";
import { ltxCellStore } from "./ltx-page-server.js";

/** A port to `files` for a worker (transfer it); `close()` stops serving it. */
export function filesApiPort(files: FilesApi): { port: MessagePort; close(): void } {
  const ch = new MessageChannel();
  const stop = serveFilesApi(ch.port1, files);
  return {
    port: ch.port2,
    close() {
      stop();
      ch.port1.close();
    },
  };
}

export interface ServeLtxStoreOptions {
  /** Names the storage: two stores with one scope never write the same cell at once. */
  lockScope: string;
  /** Files per cell before it is folded into one snapshot (default 64). */
  compactAfter?: number;
  /** Free bytes where the files are (see ltxCellStore); unknown by default. */
  room?: () => Promise<number | undefined>;
  /** Bytes of the shared buffer's payload: at least a read-ahead run (default 1 MiB). */
  payloadBytes?: number;
}

/**
 * The LTX store on `files` in this thread, for ONE shard worker's VFS: give the worker
 * `{ sab, port }` (transfer the port). This thread must not block (a page, or any worker that
 * does not run SQLite); it answers into `sab`.
 */
export function serveLtxStore(files: FilesApi, opts: ServeLtxStoreOptions) {
  const sab = new SharedArrayBuffer(8 + (opts.payloadBytes ?? 16 * 65536));
  const store = ltxCellStore(files, sab, {
    lockScope: opts.lockScope,
    compactAfter: opts.compactAfter,
    room: opts.room ?? (async () => undefined),
  });
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => store.handle(e.data);
  return {
    sab,
    port: ch.port2,
    store,
    close() {
      ch.port1.close();
      store.close();
    },
  };
}
