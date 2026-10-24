import type { Lease } from "../src/index.js";

/**
 * Leases shared by in-process "nodes": one live holder per name, the epoch grows by one per
 * acquisition. `partition(owner)` cuts an owner off: its handles are lost, the names it held
 * are free, and its own attempts to acquire fail from then on.
 */
export class MemoryLeases {
  #held = new Map<string, { owner: string; lost: AbortController }>();
  #epochs = new Map<string, number>();
  #cut = new Set<string>();

  /** The current holder of `name` (undefined when free). For routing. */
  holder(name: string): string | undefined {
    return this.#held.get(name)?.owner;
  }

  for(owner: string): Lease {
    return {
      tryAcquire: async (name) => {
        if (this.#cut.has(owner)) throw new Error("partitioned");
        if (this.#held.has(name)) return undefined;
        const epoch = (this.#epochs.get(name) ?? 0) + 1;
        this.#epochs.set(name, epoch);
        const rec = { owner, lost: new AbortController() };
        this.#held.set(name, rec);
        return {
          name,
          epoch,
          lost: rec.lost.signal,
          release: async () => {
            rec.lost.abort(new Error("released"));
            if (this.#held.get(name) === rec) this.#held.delete(name);
          },
        };
      },
    };
  }

  partition(owner: string): void {
    this.#cut.add(owner);
    for (const [name, rec] of this.#held)
      if (rec.owner === owner) {
        this.#held.delete(name);
        rec.lost.abort(new Error(`lease "${name}" lost: partitioned`));
      }
  }
}
