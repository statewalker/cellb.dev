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

/** Cloudflare's default: a container with no request for this long goes to sleep. */
export const DEFAULT_INACTIVITY_MS = 10 * 60_000;

/**
 * A Durable Object's container: Cloudflare's `ctx.container` over an engine. `start()` starts the
 * image (options merged over it) once; every call counts as activity, and a container with no
 * activity for its inactivity timeout is destroyed (the next `start()` starts a fresh one).
 */
export function createContainer(
  engine: ContainerEngine,
  image: ContainerSpec,
  opts: { label?: string } = {},
): Container {
  let handle: ContainerHandle | undefined;
  let starting: Promise<void> | undefined;
  let idleMs = DEFAULT_INACTIVITY_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const destroy = async () => {
    clearTimeout(idleTimer);
    const h = handle;
    handle = undefined;
    starting = undefined;
    await h?.destroy();
  };
  const touch = () => {
    clearTimeout(idleTimer);
    if (!handle?.running) return;
    idleTimer = setTimeout(() => void destroy().catch(() => {}), idleMs);
    (idleTimer as { unref?: () => void }).unref?.(); // never keeps a Node process alive
  };
  const need = () => {
    if (!handle?.running) throw new Error("the container is not running: call start() first");
    touch();
    return handle;
  };
  return {
    get running() {
      return !!handle?.running;
    },
    start(options = {}) {
      if (handle?.running) {
        touch();
        return Promise.resolve();
      }
      // Egress is the engine's decision: one without an egress policy refuses enableInternet.
      starting ??= engine
        .start({
          ...image,
          entrypoint: options.entrypoint ?? image.entrypoint,
          env: { ...image.env, ...options.env },
          enableInternet: options.enableInternet ?? false,
          label: opts.label ?? image.label,
        })
        .then((h) => {
          handle = h;
          starting = undefined;
          touch();
        })
        .catch((e) => {
          starting = undefined;
          throw e;
        });
      return starting;
    },
    monitor: () => need().monitor(),
    destroy,
    signal: (signo) => need().signal(signo),
    exec: (argv, options) => need().exec(argv, options),
    async spawn(argv) {
      const h = need();
      if (!h.spawn) throw new Error("this engine cannot spawn interactive processes");
      return h.spawn(argv);
    },
    waitForPort: (port, timeoutMs) => need().waitForPort(port, timeoutMs),
    setInactivityTimeout(ms) {
      idleMs = ms;
      touch();
    },
    getTcpPort(port) {
      return {
        fetch: async (input, init) => need().fetch(port, new Request(input, init)),
        connect: () => need().connect(port),
      };
    },
  };
}
