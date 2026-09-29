/**
 * Lease port: at most one live holder per name (a shard). `epoch` is a
 * monotonically increasing fencing token: every durable write of the holder
 * must carry it, so a paused ex-holder cannot overwrite its successor (P06).
 */
export interface LeaseHandle {
  readonly name: string;
  readonly epoch: number;
  /** Aborted when the holder must stop serving (renewal failed, deadline passed, fenced). */
  readonly lost: AbortSignal;
  release(): Promise<void>;
}

export interface Lease {
  tryAcquire(name: string): Promise<LeaseHandle | undefined>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Polls `tryAcquire` until it succeeds (or `signal` aborts). */
export async function acquire(
  lease: Lease,
  name: string,
  opts: { signal?: AbortSignal; pollMs?: number; clock?: Clock } = {},
): Promise<LeaseHandle> {
  const clock = opts.clock ?? systemClock;
  for (;;) {
    opts.signal?.throwIfAborted();
    const h = await lease.tryAcquire(name);
    if (h) return h;
    await new Promise<void>((r) => clock.setTimeout(r, opts.pollMs ?? 250));
  }
}
