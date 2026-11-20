// ctx.container: Cloudflare's container API (as celld implements it) over a ContainerEngine.
import type {
  ContainerEngine,
  ContainerHandle,
  ContainerSpec,
  ExecResult,
  SpawnedProcess,
  TcpSocket,
} from "./engine.ts";

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
  getTcpPort(port: number): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    connect(): TcpSocket;
  };
}

export function createContainer(
  engine: ContainerEngine,
  image: ContainerSpec,
  opts: { label?: string } = {},
): Container {
  let handle: ContainerHandle | undefined;
  let starting: Promise<void> | undefined;
  let idleMs = 10 * 60_000; // Cloudflare's default; kept for the cell host (see README)
  const need = () => {
    if (!handle?.running) throw new Error("the container is not running: call start() first");
    return handle;
  };
  return {
    get running() {
      return !!handle?.running;
    },
    start(options = {}) {
      if (handle?.running) return Promise.resolve();
      if (options.enableInternet)
        return Promise.reject(
          new Error(
            "enableInternet: true needs an egress policy, which cellb containers do not have yet",
          ),
        );
      starting ??= engine
        .start({
          ...image,
          entrypoint: options.entrypoint ?? image.entrypoint,
          env: { ...image.env, ...options.env },
          enableInternet: false,
          label: opts.label ?? image.label,
        })
        .then((h) => {
          handle = h;
          starting = undefined;
        })
        .catch((e) => {
          starting = undefined;
          throw e;
        });
      return starting;
    },
    monitor: () => need().monitor(),
    async destroy() {
      const h = handle;
      handle = undefined;
      await h?.destroy();
    },
    signal: (signo) => need().signal(signo),
    exec: (argv) => need().exec(argv),
    async spawn(argv) {
      const h = need();
      if (!h.spawn) throw new Error("this engine cannot spawn interactive processes");
      return h.spawn(argv);
    },
    waitForPort: (port, timeoutMs) => need().waitForPort(port, timeoutMs),
    setInactivityTimeout(ms) {
      idleMs = ms;
      void idleMs;
    },
    getTcpPort(port) {
      return {
        fetch: async (input, init) => need().fetch(port, new Request(input, init)),
        connect: () => need().connect(port),
      };
    },
  };
}

// The node's engine, for containerFor(). On globalThis under a registered symbol: a project's
// bundle carries its own copy of this module, and must still find the engine the host provided.
const ENGINE = Symbol.for("@statewalker/cellb-containers/engine");
type Holder = { [ENGINE]?: ContainerEngine };

/** Makes `engine` the node's engine for containerFor(); the returned function withdraws it and
 * destroys its containers (a node stop). */
export function provideContainerEngine(engine: ContainerEngine): () => Promise<void> {
  (globalThis as Holder)[ENGINE] = engine;
  return async () => {
    if ((globalThis as Holder)[ENGINE] === engine) delete (globalThis as Holder)[ENGINE];
    await engine.close();
  };
}

/** The container of a Durable Object, on the engine the node provided. Stands in for the
 * `ctx.container` cellb will give objects of a `containers` class. */
export function containerFor(
  ctx: { id: { name?: string; toString(): string } },
  image: ContainerSpec,
): Container {
  const engine = (globalThis as Holder)[ENGINE];
  if (!engine)
    throw new Error("this node has no container engine: call provideContainerEngine() in the host");
  return createContainer(engine, image, { label: ctx.id.name ?? ctx.id.toString() });
}
