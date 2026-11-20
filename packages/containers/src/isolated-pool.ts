// A pool of isolated containers: each in a worker of its own, prepared ahead of time, used once.
import type { FilesApi } from "@statewalker/webrun-files";
import type { Container } from "./container.ts";
import type { ContainerSpec } from "./engine.ts";
import type { RunOptions, RunResult } from "./pool.ts";
import type { PortLike } from "./rpc.ts";

/** A worker running serveContainerWorker(): a browser Worker or a Node worker_threads Worker. */
export type ContainerWorker = PortLike & { terminate(): unknown };

export interface IsolatedPoolOptions {
  /** Starts one worker; called for every container (workers are never reused). */
  spawn: () => ContainerWorker;
  image: Omit<ContainerSpec, "mounts">;
  /** Containers kept ready. */
  size: number;
  maxCreating?: number;
  /** Where a run's FilesApi appears in the guest. */
  mountPath?: string;
  /** A command run while warming (compiles the guest, so a run starts hot). */
  warmup?: string[];
}

export interface AcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  files?: FilesApi;
  readOnly?: boolean;
}

export interface IsolatedPool {
  readonly idle: number;
  readonly creating: number;
  ready(): Promise<void>;
  acquire(options?: AcquireOptions): Promise<Container>;
  run(options: RunOptions & { acquireTimeoutMs?: number }): Promise<RunResult>;
  close(): Promise<void>;
}

export function createIsolatedPool(_opts: IsolatedPoolOptions): IsolatedPool {
  throw new Error("not implemented");
}
