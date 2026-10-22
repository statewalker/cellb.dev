import { type ConditionalStore, PreconditionFailedError } from "./conditional-store.js";
import { type Clock, type Lease, type LeaseHandle, systemClock } from "./lease.js";

interface Record_ {
  owner: string;
  epoch: number;
  expiresAt: number;
  /** Explicitly released: free at once, no TTL wait. */
  released?: boolean;
}

export interface CasLeaseOptions {
  store: ConditionalStore;
  /** Identity of this process/peer (diagnostics only; safety comes from CAS + epoch). */
  owner: string;
  ttlMs?: number;
  renewEveryMs?: number;
  /** Bound on clock skew between hosts: holders stop early, takers wait longer. */
  skewMarginMs?: number;
  clock?: Clock;
  prefix?: string;
}

/**
 * Lease over conditional writes (S3 If-Match / If-None-Match). Safety rules:
 * - acquisition and renewal are CAS on the lease object;
 * - a taker only takes over once `expiresAt + skew` has passed on ITS clock;
 * - a holder considers the lease lost at `lastRenew + ttl - skew` on ITS clock
 *   even if it cannot reach the store (it must stop serving before anyone can
 *   take over);
 * - timing is not enough under GC pauses → every durable write is fenced by
 *   `epoch` (see FencedManifest).
 */
export class CasLease implements Lease {
  readonly #o: Required<Omit<CasLeaseOptions, "store" | "owner">> &
    Pick<CasLeaseOptions, "store" | "owner">;
  constructor(opts: CasLeaseOptions) {
    this.#o = {
      ttlMs: 10_000,
      renewEveryMs: 3_000,
      skewMarginMs: 1_000,
      clock: systemClock,
      prefix: "leases/",
      ...opts,
    };
  }

  /** The current holder of `name` (undefined when free, released or expired). For routing. */
  async holder(name: string): Promise<string | undefined> {
    const cur = await this.#o.store.get(this.#o.prefix + name);
    if (!cur) return undefined;
    const rec = JSON.parse(cur.body) as Record_;
    return !rec.released && this.#o.clock.now() <= rec.expiresAt ? rec.owner : undefined;
  }

  async tryAcquire(name: string): Promise<LeaseHandle | undefined> {
    const { store, clock, ttlMs, skewMarginMs, owner } = this.#o;
    const key = this.#o.prefix + name;
    const cur = await store.get(key);
    const now = clock.now();
    let epoch = 1;
    let cond: { ifMatch: string } | { ifNoneMatch: "*" } = { ifNoneMatch: "*" };
    if (cur) {
      const rec = JSON.parse(cur.body) as Record_;
      if (!rec.released && now <= rec.expiresAt + skewMarginMs) return undefined; // held (or maybe held)
      epoch = rec.epoch + 1;
      cond = { ifMatch: cur.etag };
    }
    try {
      const { etag } = await store.put(
        key,
        JSON.stringify({ owner, epoch, expiresAt: now + ttlMs } satisfies Record_),
        cond,
      );
      return this.#handle(name, key, epoch, etag, now);
    } catch (e) {
      if (e instanceof PreconditionFailedError) return undefined; // someone else won the race
      throw e;
    }
  }

  #handle(
    name: string,
    key: string,
    epoch: number,
    etag0: string,
    acquiredAt: number,
  ): LeaseHandle {
    const { store, clock, ttlMs, skewMarginMs, renewEveryMs, owner } = this.#o;
    const ac = new AbortController();
    let etag = etag0;
    let lastRenew = acquiredAt;
    let timer: unknown;
    let deadline: unknown;
    const lose = (why: string) => {
      if (ac.signal.aborted) return;
      clock.clearTimeout(timer);
      clock.clearTimeout(deadline);
      ac.abort(new Error(`lease "${name}" (epoch ${epoch}) lost: ${why}`));
    };
    const armDeadline = () => {
      clock.clearTimeout(deadline);
      deadline = clock.setTimeout(
        () => lose("not renewed before its local deadline"),
        lastRenew + ttlMs - skewMarginMs - clock.now(),
      );
    };
    const renew = async () => {
      if (ac.signal.aborted) return;
      const now = clock.now();
      try {
        etag = (
          await store.put(
            key,
            JSON.stringify({ owner, epoch, expiresAt: now + ttlMs } satisfies Record_),
            { ifMatch: etag },
          )
        ).etag;
        lastRenew = now;
        armDeadline();
      } catch (e) {
        if (e instanceof PreconditionFailedError) return lose("taken over");
        // transient store error: keep trying until the local deadline fires
      }
      if (!ac.signal.aborted) timer = clock.setTimeout(renew, renewEveryMs);
    };
    armDeadline();
    timer = clock.setTimeout(renew, renewEveryMs);
    return {
      name,
      epoch,
      lost: ac.signal,
      async release() {
        if (ac.signal.aborted) return;
        lose("released");
        // Expire now so the next holder need not wait for the TTL.
        await store
          .put(
            key,
            JSON.stringify({ owner, epoch, expiresAt: 0, released: true } satisfies Record_),
            { ifMatch: etag },
          )
          .catch(() => {});
      },
    };
  }
}

/**
 * Fencing for durable state: a per-shard manifest that only the current epoch
 * may advance. A new holder `claim`s it first (bumping the epoch), which
 * changes its ETag — any later write by a paused ex-holder fails its If-Match.
 * P06 will put the snapshot/changeset pointers in `state`.
 */
export class FencedManifest<S> {
  #etag: string | undefined;
  constructor(
    private readonly store: ConditionalStore,
    private readonly key: string,
    private readonly epoch: number,
  ) {}

  async claim(initial: S): Promise<S> {
    const cur = await this.store.get(this.key);
    const m = cur
      ? (JSON.parse(cur.body) as { epoch: number; state: S })
      : { epoch: 0, state: initial };
    if (m.epoch > this.epoch) throw new FencedError(this.key, this.epoch, m.epoch);
    const body = JSON.stringify({ epoch: this.epoch, state: m.state });
    this.#etag = (
      await this.store.put(this.key, body, cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" })
    ).etag;
    return m.state;
  }

  async write(state: S): Promise<void> {
    if (!this.#etag) throw new Error("claim() first");
    try {
      this.#etag = (
        await this.store.put(this.key, JSON.stringify({ epoch: this.epoch, state }), {
          ifMatch: this.#etag,
        })
      ).etag;
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw new FencedError(this.key, this.epoch);
      throw e;
    }
  }
}

export class FencedError extends Error {
  constructor(key: string, epoch: number, newer?: number) {
    super(
      `"${key}": writer with epoch ${epoch} is fenced${newer ? ` (manifest is at epoch ${newer})` : " (manifest changed under it)"}`,
    );
    this.name = "FencedError";
  }
}
