// Routing a container's filesystem calls to the thread that owns the FilesApi.
import type { FilesApi } from "@statewalker/webrun-files";
import type { PortLike } from "../rpc.ts";

export interface HostFileSystemRequest {
  type: "wasmer-filesystem-rpc";
  mount: number;
  method: string;
  args: unknown[];
  response: SharedArrayBuffer;
  binary?: boolean;
}

export type HostFilesHandler = { handle(request: HostFileSystemRequest): void };

export class HostMounts implements HostFilesHandler {
  add(_files: FilesApi, _opts: { readOnly?: boolean } = {}): number {
    throw new Error("not implemented");
  }
  remove(_id: number): void {
    throw new Error("not implemented");
  }
  handle(_request: HostFileSystemRequest): void {
    throw new Error("not implemented");
  }
}

export function installHostFiles(_handler: HostFilesHandler): () => void {
  throw new Error("not implemented");
}

export function forwardHostFiles(_port: PortLike): HostFilesHandler {
  throw new Error("not implemented");
}

export function serveHostFiles(_port: PortLike, _mounts: HostMounts): void {
  throw new Error("not implemented");
}
