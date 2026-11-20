// The ContainerEngine port and its Wasmer implementation.

/** What a container runs: the cellb counterpart of a Docker image plus `start()` options. */
export interface ContainerSpec {
  /** WASIX packages from the Wasmer registry (`python/python@=3.13.15`) or WEBC / wasm bytes. */
  packages: (string | Uint8Array)[];
  /** Files written under /workspace before the entrypoint starts. */
  files?: Record<string, string | Uint8Array>;
  /** The main process; none for an exec-only container (a sandbox). */
  entrypoint?: string[];
  env?: Record<string, string>;
  enableInternet?: boolean;
  /** Host directories (FilesApi mounts registered with HostMounts) by guest path. */
  mounts?: { path: string; id: number; readOnly?: boolean }[];
  /** For logs: usually the cell's name. */
  label?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number; reason: string }>;
  kill(): Promise<void>;
}

export interface TcpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

/** One running container. */
export interface ContainerHandle {
  readonly running: boolean;
  monitor(): Promise<{ exitCode: number; reason: string }>;
  waitForPort(port: number, timeoutMs?: number): Promise<void>;
  fetch(port: number, request: Request): Promise<Response>;
  connect(port: number): TcpSocket;
  exec(argv: string[]): Promise<ExecResult>;
  spawn?(argv: string[]): Promise<SpawnedProcess>;
  signal(signo: number): Promise<void>;
  destroy(): Promise<void>;
}

/** One per node (a Node process or a browser worker), shared by every cell the node owns. */
export interface ContainerEngine {
  /** Containers running now. */
  readonly running: number;
  start(spec: ContainerSpec): Promise<ContainerHandle>;
  /** Destroys every container (a node stop). */
  close(): Promise<void>;
}

export interface WasmerEngineOptions {
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** A ContainerEngine on a `Wasmer` client from @wasmer/sdk/node or @wasmer/sdk/browser. */
export function wasmerContainerEngine(_wasmer: unknown, _opts: WasmerEngineOptions = {}): ContainerEngine {
  throw new Error("not implemented");
}
