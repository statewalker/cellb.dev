// A pool of containers for running custom code with a FilesApi of the caller's choosing.
import type { FilesApi } from "@statewalker/webrun-files";
import type { ContainerEngine, ContainerHandle, ContainerSpec } from "./engine.ts";
import type { HostMounts } from "./files/bridge.ts";
import type { RecyclableEngine } from "./recycle.ts";

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

interface Slot {
  mountId: number;
  handle: Promise<ContainerHandle>;
}

/**
 * A pool of containers for running custom code, each run against a FilesApi of the caller's choosing.
 *
 * Isolation by construction: every run gets a sandbox nobody used before, started ahead of time,
 * and the sandbox is destroyed when the run ends. Nothing a run leaves in the guest (/workspace,
 * /tmp, environment, processes) can reach the next run, and the run's FilesApi is bound to the
 * sandbox's mount only while the run lasts, through a fresh volume (no host buffers carry over).
 *
 * `mounts` must be the HostMounts the engine's thread serves (installHostFiles).
 */
export function createContainerPool(
  engine: ContainerEngine,
  mounts: HostMounts,
  opts: ContainerPoolOptions,
): ContainerPool {
  const size = Math.max(1, opts.size ?? 2);
  const mountPath = opts.mountPath ?? "/data";
  const ready: Slot[] = [];
  const starting = new Set<Promise<unknown>>();
  const active = new Set<Promise<unknown>>();
  const waiting: (() => void)[] = [];
  let busy = 0;
  let closed = false;

  const startSlot = (): Slot => {
    const mountId = mounts.reserve();
    const handle = engine.start({
      ...opts.image,
      entrypoint: undefined,
      mounts: [{ path: mountPath, id: mountId }],
    });
    return { mountId, handle };
  };
  // Keeps `size` sandboxes started and waiting, minus those running.
  const refill = () => {
    while (!closed && ready.length + starting.size < size - busy) {
      const slot = startSlot();
      const p: Promise<unknown> = slot.handle.then(
        () => {
          starting.delete(p);
          if (closed) void slot.handle.then((h) => h.destroy()).catch(() => {});
          else ready.push(slot);
        },
        () => starting.delete(p),
      );
      starting.add(p);
    }
  };
  const acquire = async () => {
    while (busy >= size) await new Promise<void>((r) => waiting.push(r));
    busy++;
  };
  const release = () => {
    busy--;
    waiting.shift()?.();
    refill();
  };

  return {
    get idle() {
      return ready.length;
    },
    get busy() {
      return busy;
    },
    async warm() {
      refill();
      await Promise.all([...starting]);
    },
    async run(run) {
      if (closed) throw new Error("the pool is closed");
      await acquire();
      const t0 = performance.now();
      const slot = ready.shift() ?? startSlot();
      let handle: ContainerHandle | undefined;
      let abandoned = false;
      const work = (async (): Promise<RunResult> => {
        try {
          handle = await slot.handle;
          if (run.files) mounts.bind(slot.mountId, run.files, { readOnly: run.readOnly });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<"timeout">((resolve) => {
            if (run.timeoutMs) timer = setTimeout(() => resolve("timeout"), run.timeoutMs);
          });
          const out = await Promise.race([
            handle.exec(run.argv, { env: run.env, cwd: run.cwd }),
            timeout,
          ]);
          clearTimeout(timer);
          const ms = Math.round(performance.now() - t0);
          if (out === "timeout") {
            // A guest that ignores kill() keeps its worker busy: replace the engine's instance,
            // if it can be, and drop the idle sandboxes that would keep the old one alive.
            const recyclable = engine as Partial<RecyclableEngine>;
            if (recyclable.recycle) {
              abandoned = true;
              recyclable.recycle(handle);
              for (const idle of ready.splice(0))
                void idle.handle.then((h) => h.destroy()).catch(() => {});
            }
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
          // The run is over: its files are no longer reachable, and its sandbox is not reused.
          mounts.remove(slot.mountId);
          // An abandoned sandbox goes with its engine instance; do not wait for it.
          if (abandoned) void handle?.destroy().catch(() => {});
          else await handle?.destroy().catch(() => {});
          release();
        }
      })();
      active.add(work);
      void work.finally(() => active.delete(work)).catch(() => {});
      return work;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...starting]);
      await Promise.allSettled(ready.splice(0).map(async (s) => (await s.handle).destroy()));
      await Promise.allSettled([...active]);
      for (const w of waiting.splice(0)) w();
    },
  };
}

// Pools by name, for Durable Objects: a project's bundle carries its own copy of this module,
// so the registry is on globalThis under a registered symbol.
const POOLS = Symbol.for("@statewalker/cellb-containers/pools");
const registry = () =>
  ((globalThis as { [POOLS]?: Map<string, ContainerPool> })[POOLS] ??= new Map());

/** Makes `pool` reachable by `name` with containerPool(); returns a function that withdraws it. */
export function provideContainerPool(name: string, pool: ContainerPool): () => void {
  registry().set(name, pool);
  return () => {
    if (registry().get(name) === pool) registry().delete(name);
  };
}

/** The pool the host provided under `name`. */
export function containerPool(name: string): ContainerPool {
  const pool = registry().get(name);
  if (!pool)
    throw new Error(
      `no container pool "${name}" on this node: call provideContainerPool() in the host`,
    );
  return pool;
}
