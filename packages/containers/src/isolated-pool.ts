// A pool of isolated containers: each in a worker of its own, prepared ahead of time, used once.
import type { FilesApi } from "@statewalker/webrun-files";
import type { Container } from "./container.ts";
import type { ContainerEngine, ContainerHandle, ContainerSpec } from "./engine.ts";
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
  /** Failed starts in a row after which waiting runs fail with the cause (default 5). */
  failAfter?: number;
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
  /** A container with slots and no run for this long is terminated (default 30 s). */
  idleMs?: number;
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
  engine: ContainerEngine;
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
          return { ...partial, engine, handle };
        } catch (e) {
          terminate(partial);
          throw e;
        } finally {
          clearTimeout(timer);
        }
      },
      destroy: (slot) => terminate(slot),
    },
    { size: opts.size, maxCreating: opts.maxCreating, failAfter: opts.failAfter },
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
          // a Request as is: an upgrade request keeps its headers as an own property
          // (browsers drop Upgrade and Sec-* from a copy)
          fetch: async (input, init) =>
            live().fetch(
              port,
              input instanceof Request && !init ? input : new Request(input, init),
            ),
          connect: () => live().connect(port),
        };
      },
    };
  };

  // ---- containers with several script slots ----------------------------------------------
  const slots = Math.max(1, opts.slots ?? 1);
  const isolation = opts.isolation ?? "sandbox";
  const maxRuns = opts.maxRunsPerContainer ?? 200;
  const drainMs = opts.drainMs ?? 30_000;
  const idleMs = opts.idleMs ?? 30_000;
  interface Active {
    slot: Promise<Slot>;
    inflight: number;
    runs: number;
    retiring: boolean;
    terminated: boolean;
    key?: string;
    files?: FilesApi;
    /** Sandbox mode: the sandbox started while warming, not used by any run yet. */
    fresh: boolean;
    idleTimer?: ReturnType<typeof setTimeout>;
  }
  const actives: Active[] = [];

  const end = async (a: Active) => {
    if (a.terminated) return;
    a.terminated = true;
    clearTimeout(a.idleTimer);
    actives.splice(actives.indexOf(a), 1);
    const slot = await a.slot.catch(() => undefined);
    if (slot) await pool.destroy(slot);
  };
  const retire = (a: Active, grace = 0) => {
    a.retiring = true;
    if (a.inflight === 0) void end(a);
    else if (grace) setTimeout(() => void end(a), grace);
  };
  const settle = (a: Active) => {
    a.inflight--;
    a.runs++;
    if (a.runs >= maxRuns) a.retiring = true;
    if (a.inflight > 0) return;
    if (a.retiring) void end(a);
    else a.idleTimer = setTimeout(() => retire(a), idleMs);
  };
  const pick = (run: IsolatedRunOptions): Active => {
    if (isolation === "shared") {
      if (!run.capabilities)
        throw new Error('isolation "shared" needs a capabilities key for each run');
      const bound = actives.find((a) => a.key === run.capabilities && !a.retiring);
      if (bound && bound.files !== run.files)
        throw new Error(
          `capabilities "${run.capabilities}" are bound to other files: one key, one FilesApi`,
        );
    }
    const free = actives.find(
      (a) =>
        !a.retiring &&
        a.inflight < slots &&
        (isolation === "sandbox" || a.key === run.capabilities),
    );
    const a: Active = free ?? {
      slot: pool.acquire({ timeoutMs: run.acquireTimeoutMs }),
      inflight: 0,
      runs: 0,
      retiring: false,
      terminated: false,
      fresh: true,
      key: isolation === "shared" ? run.capabilities : undefined,
      files: isolation === "shared" ? run.files : undefined,
    };
    if (!free) {
      actives.push(a);
      a.slot.catch(() => void end(a));
      if (isolation === "shared" && run.files)
        void a.slot
          .then((slot) =>
            mounts.bind(slot.mountId, run.files as FilesApi, { readOnly: run.readOnly }),
          )
          .catch(() => {});
    }
    clearTimeout(a.idleTimer);
    a.inflight++;
    return a;
  };
  const runInSlot = async (run: IsolatedRunOptions): Promise<RunResult> => {
    const t0 = performance.now();
    const a = pick(run);
    let handle: ContainerHandle | undefined;
    let mountId: number | undefined;
    let ownSandbox = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const slot = await a.slot;
      if (isolation === "shared") handle = slot.handle;
      else if (a.fresh) {
        a.fresh = false;
        handle = slot.handle;
        mountId = slot.mountId;
        ownSandbox = true;
      } else {
        mountId = mounts.reserve();
        handle = await slot.engine.start({
          ...opts.image,
          mounts: [{ path: mountPath, id: mountId }],
        });
        ownSandbox = true;
      }
      if (isolation === "sandbox" && run.files && mountId !== undefined)
        mounts.bind(mountId, run.files, { readOnly: run.readOnly });
      const out = await Promise.race([
        handle.exec(run.argv, { env: run.env, cwd: run.cwd }),
        new Promise<"timeout">((resolve) => {
          if (run.timeoutMs) timer = setTimeout(() => resolve("timeout"), run.timeoutMs);
        }),
      ]);
      const ms = Math.round(performance.now() - t0);
      if (out === "timeout") {
        timedOut = true;
        return {
          exitCode: 124,
          stdout: "",
          stderr: `timed out after ${run.timeoutMs} ms`,
          timedOut: true,
          ms,
        };
      }
      return { ...out, timedOut: false, ms };
    } finally {
      clearTimeout(timer);
      if (isolation === "sandbox" && mountId !== undefined) mounts.remove(mountId);
      if (timedOut) {
        // The guest may ignore kill(): the worker goes, once its other scripts had their time.
        a.inflight--;
        retire(a, drainMs);
      } else {
        if (ownSandbox) await handle?.destroy().catch(() => {});
        settle(a);
      }
    }
  };

  return {
    get idle() {
      return pool.idle;
    },
    get creating() {
      return pool.creating;
    },
    get containers() {
      return actives.length;
    },
    ready: () => pool.ready(),
    async acquire(options = {}) {
      const slot = await pool.acquire({ timeoutMs: options.timeoutMs, signal: options.signal });
      if (options.files) mounts.bind(slot.mountId, options.files, { readOnly: options.readOnly });
      return containerOf(slot);
    },
    async run(run) {
      if (slots > 1 || isolation === "shared") return runInSlot(run);
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
    async close() {
      await Promise.all([...actives].map(end));
      await pool.close();
    },
  };
}
