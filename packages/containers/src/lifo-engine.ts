// A ContainerEngine on Lifo (https://lifo.sh): a Linux-like OS in TypeScript (kernel, shell, VFS,
// Node-compatible JS). Run it inside a worker of its own (serveContainerWorker): Lifo's in-realm
// Sandbox is not a security boundary, and terminating the worker is what frees it.
import type { ContainerEngine } from "./engine.ts";
import type { PortLike } from "./rpc.ts";

/** The part of @lifo-sh/core's Sandbox class this engine uses. */
export interface LifoSandboxClass {
  create(options?: {
    env?: Record<string, string>;
    cwd?: string;
    files?: Record<string, string | Uint8Array>;
  }): Promise<unknown>;
}

export function lifoContainerEngine(
  _Sandbox: LifoSandboxClass,
  _opts: { files?: PortLike } = {},
): ContainerEngine {
  throw new Error("not implemented");
}
