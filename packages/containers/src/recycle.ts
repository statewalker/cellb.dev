// An engine that can be replaced: for runaway guests that no kill() stops.
import type { ContainerEngine, ContainerHandle } from "./engine.ts";

export interface EngineInstance {
  engine: ContainerEngine;
  /** Stops the engine for good, whatever its guests are doing (terminate its worker). */
  terminate(): Promise<void> | void;
}

export interface RecyclableEngine extends ContainerEngine {
  /** Incremented by each recycle(). */
  readonly generation: number;
  /**
   * Sends new starts to a fresh instance and terminates the current one once its containers are
   * gone. `abandoned`: a container that will never end by itself (a guest ignoring kill()); it no
   * longer holds the old instance open.
   */
  recycle(abandoned?: ContainerHandle): void;
  terminate(): Promise<void>;
}

interface Generation {
  instance: EngineInstance;
  live: number;
  draining: boolean;
  ended: boolean;
}

/**
 * An engine whose instance (normally a Wasmer client in a worker of its own) can be replaced.
 * A guest in a pure compute loop never yields to the runtime, so kill() does not stop it, and its
 * thread keeps running after its sandbox is destroyed. recycle() sends new starts to a fresh
 * instance and terminates the old one as soon as its containers are gone (terminating its worker
 * stops every thread in it).
 */
export function recyclableEngine(spawn: () => EngineInstance): RecyclableEngine {
  const generations = new Set<Generation>();
  // Each handle's generation, while it still counts toward that generation's live containers.
  const counted = new WeakMap<ContainerHandle, Generation>();
  let current: Generation | undefined;
  let generation = 0;

  const currentGeneration = () => {
    if (!current) {
      current = { instance: spawn(), live: 0, draining: false, ended: false };
      generations.add(current);
    }
    return current;
  };
  const end = async (g: Generation) => {
    if (g.ended) return;
    g.ended = true;
    generations.delete(g);
    await g.instance.terminate();
  };
  const maybeEnd = (g: Generation) => {
    if (g.draining && g.live === 0) void end(g);
  };

  return {
    get generation() {
      return generation;
    },
    get running() {
      let n = 0;
      for (const g of generations) n += g.live;
      return n;
    },
    async start(spec) {
      const g = currentGeneration();
      const handle = await g.instance.engine.start(spec);
      g.live++;
      counted.set(handle, g);
      const uncount = () => {
        if (counted.get(handle) !== g) return;
        counted.delete(handle);
        g.live--;
        maybeEnd(g);
      };
      void handle.monitor().then(uncount, uncount);
      return handle;
    },
    recycle(abandoned) {
      const old = (abandoned && counted.get(abandoned)) || current;
      if (!old) return;
      if (old === current) {
        current = undefined;
        generation++;
      }
      old.draining = true;
      if (abandoned && counted.get(abandoned) === old) {
        counted.delete(abandoned);
        old.live--;
      }
      maybeEnd(old);
    },
    async close() {
      await Promise.all([...generations].map((g) => g.instance.engine.close().catch(() => {})));
    },
    async terminate() {
      current = undefined;
      await Promise.all([...generations].map(end));
    },
  };
}
