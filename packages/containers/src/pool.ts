// A pool of containers for running custom code with a FilesApi of the caller's choosing.
import type { FilesApi } from "@statewalker/webrun-files";
import type { ContainerEngine, ContainerSpec } from "./engine.ts";
import type { HostMounts } from "./files/bridge.ts";

export interface ContainerPoolOptions {
  /** What every sandbox of the pool runs (no entrypoint: runs are exec'd into it). */
  image: Omit<ContainerSpec, "entrypoint" | "mounts">;
  /** Sandboxes kept started; also the most runs at once. */
  size?: number;
  /** Where a run's FilesApi appears in the guest. */
  mountPath?: string;
}

export interface RunOptions {
  argv: string[];
  files?: FilesApi;
  readOnly?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface ContainerPool {
  readonly idle: number;
  readonly busy: number;
  run(options: RunOptions): Promise<RunResult>;
  warm(): Promise<void>;
  close(): Promise<void>;
}

export function createContainerPool(
  _engine: ContainerEngine,
  _mounts: HostMounts,
  _opts: ContainerPoolOptions,
): ContainerPool {
  throw new Error("not implemented");
}

export function provideContainerPool(_name: string, _pool: ContainerPool): () => void {
  throw new Error("not implemented");
}

export function containerPool(_name: string): ContainerPool {
  throw new Error("not implemented");
}
