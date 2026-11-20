// ctx.container: Cloudflare's container API (as celld implements it) over a container engine.
// The engine is a port: @statewalker/cellb-containers provides Wasmer and Lifo engines.

export interface ContainerSpec {
  packages: (string | Uint8Array)[];
  files?: Record<string, string | Uint8Array>;
  entrypoint?: string[];
  env?: Record<string, string>;
  enableInternet?: boolean;
  mounts?: { path: string; id: number; readOnly?: boolean }[];
  label?: string;
}
export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
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
export interface ContainerHandle {
  readonly running: boolean;
  monitor(): Promise<{ exitCode: number; reason: string }>;
  waitForPort(port: number, timeoutMs?: number): Promise<void>;
  fetch(port: number, request: Request): Promise<Response>;
  connect(port: number): TcpSocket;
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  spawn?(argv: string[]): Promise<SpawnedProcess>;
  signal(signo: number): Promise<void>;
  destroy(): Promise<void>;
}
export interface ContainerEngine {
  readonly running: number;
  start(spec: ContainerSpec): Promise<ContainerHandle>;
  close(): Promise<void>;
}
export interface StartOptions {
  entrypoint?: string[];
  env?: Record<string, string>;
  enableInternet?: boolean;
}
export interface Container {
  readonly running: boolean;
  start(options?: StartOptions): Promise<void>;
  monitor(): Promise<{ exitCode: number; reason: string }>;
  destroy(): Promise<void>;
  signal(signo: number): Promise<void>;
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  spawn(argv: string[]): Promise<SpawnedProcess>;
  waitForPort(port: number, timeoutMs?: number): Promise<void>;
  setInactivityTimeout(ms: number): void;
  getTcpPort(port: number): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    connect(): TcpSocket;
  };
}

export function createContainer(
  _engine: ContainerEngine,
  _image: ContainerSpec,
  _opts: { label?: string } = {},
): Container {
  throw new Error("not implemented");
}
