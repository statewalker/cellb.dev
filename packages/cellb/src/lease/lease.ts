import { type Clock, type Lease, type LeaseHandle, systemClock } from "../ports.js";

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
