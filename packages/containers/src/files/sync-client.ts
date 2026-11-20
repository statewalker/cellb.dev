// A synchronous client of the host-filesystem protocol, for runtimes whose filesystem hooks are
// synchronous (Lifo's MountProvider): it posts a request and blocks on Atomics.wait until the
// thread that owns the FilesApi (serveHostFiles) writes the reply. Never call it on that thread.
import type { PortLike } from "../rpc.ts";

export type SyncFilesCall = (method: string, args: unknown[]) => unknown;

export function syncHostFiles(_port: PortLike, _mount: number): SyncFilesCall {
  throw new Error("not implemented");
}
