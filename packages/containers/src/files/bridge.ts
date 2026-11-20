// Routing a container's filesystem calls to the thread that owns the FilesApi.
//
// How a call travels (Wasmer SDK's host-filesystem bridge, patched to also run in Node):
//   1. A guest thread runs in a Wasmer pool worker. Its call on a mounted path posts
//      { type: "wasmer-filesystem-rpc", mount, method, args, response: SharedArrayBuffer }
//      to the Wasmer client's thread, then blocks on Atomics.wait until the reply is written.
//   2. The client's thread hands the message to globalThis.__wasmerHandleFileSystemRpc:
//      installHostFiles() puts a handler there.
//   3. The handler answers it (HostMounts) or forwards it over a port (forwardHostFiles) to a
//      thread that owns the FilesApi (serveHostFiles): the page's main thread or another worker.
//   4. Whoever holds the message writes the reply into its SharedArrayBuffer and notifies.
// Only the guest's thread ever blocks, so any thread with a free event loop can serve.
import type { FilesApi } from "@statewalker/webrun-files";
import type { PortLike } from "../rpc.ts";
import { FilesVolume, filesystemError } from "./volume.ts";

export interface HostFileSystemRequest {
  type: "wasmer-filesystem-rpc";
  mount: number;
  method: string;
  args: unknown[];
  response: SharedArrayBuffer;
  binary?: boolean;
}

export type HostFilesHandler = { handle(request: HostFileSystemRequest): void };

export const HOST_FS_MESSAGE = "wasmer-filesystem-rpc";
const HEADER_BYTES = 8;

export function isHostFileSystemRequest(value: unknown): value is HostFileSystemRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === HOST_FS_MESSAGE
  );
}

/**
 * Writes a reply into the request's SharedArrayBuffer and wakes the guest (the same encoding as
 * the SDK's respondToHostFileSystem, which its package does not export).
 */
export function respondToHostFileSystem(
  request: HostFileSystemRequest,
  reply: { value?: unknown; error?: { code: string; message: string } },
) {
  const control = new Int32Array(request.response, 0, 2);
  const value = reply.value;
  let binary = request.binary === true && !reply.error && value instanceof Uint8Array;
  let bytes = binary
    ? (value as Uint8Array)
    : new TextEncoder().encode(
        JSON.stringify(
          value instanceof Uint8Array ? { ...reply, value: Array.from(value) } : reply,
        ),
      );
  if (bytes.length > request.response.byteLength - HEADER_BYTES) {
    binary = false;
    bytes = new TextEncoder().encode(
      JSON.stringify({ error: { code: "EIO", message: "reply exceeds the bridge limit" } }),
    );
  }
  new Uint8Array(request.response, HEADER_BYTES, bytes.length).set(bytes);
  control[1] = bytes.length;
  Atomics.store(control, 0, binary ? 2 : 1);
  Atomics.notify(control, 0);
}

/** FilesApi volumes by mount id, answering requests for them on this thread. */
export class HostMounts implements HostFilesHandler {
  readonly #volumes = new Map<number, { volume: FilesVolume; queue: Promise<unknown> }>();
  #next = 1;

  /** Registers a FilesApi; pass the returned id as a container mount's `id`. */
  add(files: FilesApi, opts: { readOnly?: boolean } = {}): number {
    const id = this.#next++;
    this.#volumes.set(id, { volume: new FilesVolume(files, opts), queue: Promise.resolve() });
    return id;
  }

  remove(id: number): void {
    this.#volumes.delete(id);
  }

  /** Mounts with a FilesApi bound. */
  get size(): number {
    throw new Error("not implemented");
  }

  /** An id with nothing bound yet: its calls answer ENOENT until bind(). */
  reserve(): number {
    throw new Error("not implemented");
  }

  /** Binds a FilesApi to a reserved id (a fresh volume: nothing carries over from before). */
  bind(_id: number, _files: FilesApi, _opts: { readOnly?: boolean } = {}): void {
    throw new Error("not implemented");
  }

  handle(request: HostFileSystemRequest): void {
    const entry = this.#volumes.get(request.mount);
    if (!entry) {
      respondToHostFileSystem(request, {
        error: { code: "ENOENT", message: `no mount ${request.mount}` },
      });
      return;
    }
    // One call at a time per volume, in arrival order (guest threads may call concurrently).
    entry.queue = entry.queue.then(async () => {
      try {
        respondToHostFileSystem(request, {
          value: await entry.volume.request(request.method, request.args),
        });
      } catch (e) {
        respondToHostFileSystem(request, { error: filesystemError(e) });
      }
    });
  }
}

type Global = { __wasmerHandleFileSystemRpc?: (message: unknown) => boolean };

/**
 * Installs `handler` for the Wasmer client on THIS thread (the thread that called `new Wasmer()`).
 * Returns a function that uninstalls it.
 */
export function installHostFiles(handler: HostFilesHandler): () => void {
  const g = globalThis as Global;
  const previous = g.__wasmerHandleFileSystemRpc;
  const fn = (message: unknown) => {
    if (!isHostFileSystemRequest(message)) return previous?.(message) ?? false;
    handler.handle(message);
    return true;
  };
  g.__wasmerHandleFileSystemRpc = fn;
  return () => {
    if (g.__wasmerHandleFileSystemRpc === fn) g.__wasmerHandleFileSystemRpc = previous;
  };
}

/** A handler that sends each request to `port`; serveHostFiles() answers on the other end. */
export function forwardHostFiles(port: PortLike): HostFilesHandler {
  return { handle: (request) => port.postMessage(request) };
}

/** Answers the requests that arrive on `port` from `mounts` (on the thread that owns the FilesApi). */
export function serveHostFiles(port: PortLike, mounts: HostMounts): void {
  onMessage(port, (data) => {
    if (isHostFileSystemRequest(data)) mounts.handle(data);
  });
}

/** A browser MessagePort / Worker, or a Node MessagePort / Worker / parentPort. */
export function onMessage(port: PortLike, fn: (data: any) => void): void {
  const p = port as any;
  if (typeof p.on === "function") p.on("message", fn);
  else {
    p.addEventListener("message", (e: MessageEvent) => fn(e.data));
    p.start?.();
  }
}
