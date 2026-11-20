// A pool of isolated containers: each in a worker of its own, prepared ahead of time, used once.
import type { FilesApi } from "@statewalker/webrun-files";
import type { Container } from "./container.ts";
import type { ContainerHandle, ContainerSpec } from "./engine.ts";
import { HostMounts, serveHostFiles } from "./files/bridge.ts";
import type { RunOptions, RunResult } from "./pool.ts";
import type { PortLike } from "./rpc.ts";
import { connectEngine } from "./rpc.ts";
import { WarmPool } from "./warm-pool.ts";

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
  /** Gives up on a container that is not ready after this long (default 120 s). */
  createTimeoutMs?: number;
  /**
   * Scripts one container (worker) runs at once (default 1: a container per run, terminated
   * after it). Lifo: 1 (a box runs one command at a time, and boxes in one worker share console).
   */
  slots?: number;
  /**
   * With slots > 1: "sandbox" gives each script a fresh sandbox in the worker's engine (its own
   * files, /tmp, /workspace, env; verified for Wasmer); "shared" runs a container's scripts in one
   * sandbox, so a container is bound to one capabilities key.
   */
  isolation?: "sandbox" | "shared";
  /** A container with slots is retired after this many runs (default 200). */
  maxRunsPerContainer?: number;
  /** After a timeout, how long a retiring container's other scripts may take (default 30 s). */
  drainMs?: number;
}

export interface AcquireOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  files?: FilesApi;
  readOnly?: boolean;
}

export interface IsolatedRunOptions extends RunOptions {
  acquireTimeoutMs?: number;
  /** With isolation "shared": the key a container is bound to (same key, same FilesApi view). */
  capabilities?: string;
}

export interface IsolatedPool {
  readonly idle: number;
  readonly creating: number;
  ready(): Promise<void>;
  acquire(options?: AcquireOptions): Promise<Container>;
  run(options: IsolatedRunOptions): Promise<RunResult>;
  /** Containers in use (with slots: serving runs or bound to a key). */
  readonly containers: number;
  close(): Promise<void>;
}

interface Slot {
  worker: ContainerWorker;
  handle: ContainerHandle;
  mountId: number;
  ports: { close?(): void }[];
}

/**
 * A pool of isolated containers. Each container runs in a worker of its own (a Wasmer client, or
 * any engine served with serveContainerWorker), is prepared ahead of time, is handed out once, and
 * goes with its worker: terminating a worker stops everything in it, a guest stuck in a compute
 * loop included, and gives its memory back. A replacement starts as soon as one is taken; when
 * none is ready, requests wait.
 */
export function createIsolatedPool(opts: IsolatedPoolOptions): IsolatedPool {
  const mounts = new HostMounts(); // the runs' FilesApis, served on this thread
  const mountPath = opts.mountPath ?? "/data";
  const createTimeoutMs = opts.createTimeoutMs ?? 120_000;

  const terminate = (slot: Pick<Slot, "worker" | "ports" | "mountId">) => {
    mounts.remove(slot.mountId);
    for (const p of slot.ports) p.close?.();
    void Promise.resolve(slot.worker.terminate()).catch(() => {});
  };

  const pool = new WarmPool<Slot>(
    {
      async create() {
        const worker = opts.spawn();
        const engineChannel = new MessageChannel();
        const filesChannel = new MessageChannel();
        serveHostFiles(filesChannel.port1, mounts);
        worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
          engineChannel.port2,
          filesChannel.port2,
        ]);
        const mountId = mounts.reserve();
        const partial = { worker, mountId, ports: [engineChannel.port1, filesChannel.port1] };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const engine = connectEngine(engineChannel.port1);
          const start = (async () => {
            const handle = await engine.start({
              ...opts.image,
              mounts: [{ path: mountPath, id: mountId }],
            });
            if (opts.warmup) await handle.exec(opts.warmup);
            return handle;
          })();
          const handle = await Promise.race([
            start,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`no container ready after ${createTimeoutMs} ms`)),
                createTimeoutMs,
              );
            }),
          ]);
          return { ...partial, handle };
        } catch (e) {
          terminate(partial);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      },
      destroy: (slot) => terminate(slot),
    },
    { size: opts.size, maxCreating: opts.maxCreating },
  );

  const containerOf = (slot: Slot): Container => {
    let destroyed = false;
    const live = () => {
      if (destroyed) throw new Error("the container was destroyed");
      return slot.handle;
    };
    return {
      get running() {
        return !destroyed && slot.handle.running;
      },
      async start() {
        live(); // started while warming
      },
      monitor: () => live().monitor(),
      async destroy() {
        if (destroyed) return;
        destroyed = true;
        await pool.destroy(slot);
      },
      signal: (signo) => live().signal(signo),
      exec: (argv, options) => live().exec(argv, options),
      async spawn(argv) {
        const h = live();
        if (!h.spawn) throw new Error("this engine cannot spawn interactive processes");
        return h.spawn(argv);
      },
      waitForPort: (port, timeoutMs) => live().waitForPort(port, timeoutMs),
      setInactivityTimeout() {},
      getTcpPort(port) {
        return {
          fetch: async (input, init) => live().fetch(port, new Request(input, init)),
          connect: () => live().connect(port),
        };
      },
    };
  };

  return {
    get idle() {
      return pool.idle;
    },
    get creating() {
      return pool.creating;
    },
    get containers() {
      return 0; // not implemented yet
    },
    ready: () => pool.ready(),
    async acquire(options = {}) {
      const slot = await pool.acquire({ timeoutMs: options.timeoutMs, signal: options.signal });
      if (options.files) mounts.bind(slot.mountId, options.files, { readOnly: options.readOnly });
      return containerOf(slot);
    },
    async run(run) {
      const t0 = performance.now();
      const c = await this.acquire({
        files: run.files,
        readOnly: run.readOnly,
        timeoutMs: run.acquireTimeoutMs,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const out = await Promise.race([
          c.exec(run.argv, { env: run.env, cwd: run.cwd }),
          new Promise<"timeout">((resolve) => {
            if (run.timeoutMs) timer = setTimeout(() => resolve("timeout"), run.timeoutMs);
          }),
        ]);
        const ms = Math.round(performance.now() - t0);
        if (out === "timeout")
          return {
            exitCode: 124,
            stdout: "",
            stderr: `timed out after ${run.timeoutMs} ms`,
            timedOut: true,
            ms,
          };
        return { ...out, timedOut: false, ms };
      } finally {
        clearTimeout(timer);
        await c.destroy(); // terminates the worker, whatever the guest is doing
      }
    },
    close: () => pool.close(),
  };
}
