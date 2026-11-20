// ctx.container: Cloudflare's container API (as celld implements it) over a ContainerEngine.
import type { ContainerEngine, ContainerSpec, ExecResult, SpawnedProcess, TcpSocket } from "./engine.ts";

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
  exec(argv: string[]): Promise<ExecResult>;
  spawn(argv: string[]): Promise<SpawnedProcess>;
  /** Not in Cloudflare's API (its Container class polls with fetch). */
  waitForPort(port: number, timeoutMs?: number): Promise<void>;
  setInactivityTimeout(ms: number): void;
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; connect(): TcpSocket };
}

export function createContainer(_engine: ContainerEngine, _image: ContainerSpec, _opts: { label?: string } = {}): Container {
  throw new Error("not implemented");
}

/** The container of a Durable Object, on the engine the node provided. */
export function containerFor(_ctx: { id: { name?: string; toString(): string } }, _image: ContainerSpec): Container {
  throw new Error("not implemented");
}

/** Makes `engine` the node's engine for containerFor(); returns a function that withdraws it. */
export function provideContainerEngine(_engine: ContainerEngine): () => Promise<void> {
  throw new Error("not implemented");
}
