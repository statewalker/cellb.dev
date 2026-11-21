// ctx.container: Cloudflare's container API (as celld implements it) over a container engine.
// The engine is a port: @statewalker/cellb-containers provides Wasmer and Lifo engines.

export interface ContainerSpec {
  packages: (string | Uint8Array)[];
  files?: Record<string, string | Uint8Array>;
  entrypoint?: string[];
  /** The working directory of the entrypoint and the default one of exec() (Docker's WORKDIR). */
  workdir?: string;
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
 * image (options merged over it) once. A container with no activity for its inactivity timeout is
 * destroyed (the next `start()` starts a fresh one): every call is activity, and so is a call
 * still running (an exec, a request through a port, an open socket), so the timer only counts
 * while none is.
 */
export function createContainer(
  engine: ContainerEngine,
  image: ContainerSpec,
  opts: {
    label?: string;
    /** Why a start is refused now (a runtime that is closing), or undefined to allow it. */
    refuse?: () => string | undefined;
  } = {},
): Container {
  let handle: ContainerHandle | undefined;
  let starting: Promise<void> | undefined;
  // bumped by destroy(): a start that finishes after it destroys what it started
  let generation = 0;
  let busy = 0;
  let idleMs = DEFAULT_INACTIVITY_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const destroy = async () => {
    generation++;
    clearTimeout(idleTimer);
    const h = handle;
    handle = undefined;
    starting = undefined;
    await h?.destroy();
  };
  const touch = () => {
    clearTimeout(idleTimer);
    if (!handle?.running || busy > 0) return;
    idleTimer = setTimeout(() => void destroy().catch(() => {}), idleMs);
    (idleTimer as { unref?: () => void }).unref?.(); // never keeps a Node process alive
  };
  const need = async () => {
    if (!handle?.running) throw new Error("the container is not running: call start() first");
    touch();
    return handle;
  };
  /** Runs `fn` as activity: the inactivity timer waits until it ends. */
  const during = async <T>(fn: (h: ContainerHandle) => Promise<T>): Promise<T> => {
    const h = await need();
    busy++;
    clearTimeout(idleTimer);
    try {
      return await fn(h);
    } finally {
      busy--;
      touch();
    }
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
      const refused = opts.refuse?.();
      if (refused) return Promise.reject(new Error(`the container cannot start: ${refused}`));
      const gen = generation;
      // Egress is the engine's decision: one without an egress policy refuses enableInternet.
      starting ??= engine
        .start({
          ...image,
          entrypoint: options.entrypoint ?? image.entrypoint,
          env: { ...image.env, ...options.env },
          enableInternet: options.enableInternet ?? false,
          label: opts.label ?? image.label,
        })
        .then(async (h) => {
          if (gen !== generation) {
            // destroyed (or closed) while starting: what started does not outlive that
            await h.destroy().catch(() => {});
            throw new Error("the container was destroyed while it started");
          }
          handle = h;
          starting = undefined;
          touch();
        })
        .catch((e) => {
          if (gen === generation) starting = undefined;
          throw e;
        });
      return starting;
    },
    monitor: async () => (await need()).monitor(),
    destroy,
    signal: async (signo) => (await need()).signal(signo),
    exec: (argv, options) => during((h) => h.exec(argv, options)),
    async spawn(argv) {
      const h = await need();
      if (!h.spawn) throw new Error("this engine cannot spawn interactive processes");
      // activity until the process exits
      busy++;
      clearTimeout(idleTimer);
      try {
        const p = await h.spawn(argv);
        void p
          .wait()
          .catch(() => {})
          .finally(() => {
            busy--;
            touch();
          });
        return p;
      } catch (e) {
        busy--;
        touch();
        throw e;
      }
    },
    waitForPort: async (port, timeoutMs) => (await need()).waitForPort(port, timeoutMs),
    setInactivityTimeout(ms) {
      idleMs = ms;
      touch();
    },
    getTcpPort(port) {
      return {
        // a Request as is: an upgrade request keeps its headers as an own property
        // (browsers drop Upgrade and Sec-* from a copy). Activity until the response arrives
        // (a WebSocket after its 101 is the caller's to keep alive with calls).
        fetch: (input, init) =>
          during((h) =>
            h.fetch(port, input instanceof Request && !init ? input : new Request(input, init)),
          ),
        connect: () => {
          if (!handle?.running) throw new Error("the container is not running: call start() first");
          const socket = handle.connect(port);
          // activity while the socket is open
          busy++;
          clearTimeout(idleTimer);
          let open = true;
          return {
            readable: socket.readable,
            writable: socket.writable,
            close() {
              if (open) {
                open = false;
                busy--;
                touch();
              }
              socket.close();
            },
          };
        },
      };
    },
  };
}
