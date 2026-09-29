import { idFromName } from "../core/id.js";
import { shardOf } from "../core/shard.js";
import { errorResponse, H, type Send, stripControl } from "../transport/cells-http.js";

export interface CellRouterOptions {
  shards: number;
  /** Durable Object binding → class name (namespace key), as in wrangler config. */
  bindings: Record<string, string>;
  /** Called when a request needs a shard that has no live link (e.g. ask pages to re-attach). */
  onMissingShard?: (shard: number) => void;
  /** How long a request waits for its shard to be attached (default 10 s). */
  attachTimeoutMs?: number;
  /**
   * Liveness probe of the owner that attached `token`. Polled every
   * `livenessIntervalMs` while the shard has requests in flight; `false`
   * invalidates the link. In a ServiceWorker: is the shard's Web Lock still
   * held by the same holder? (MessagePort has no close event in Chromium.)
   */
  isAlive?: (shard: number, token: unknown) => Promise<boolean>;
  livenessIntervalMs?: number;
  /**
   * Event-driven liveness (preferred over polling): resolves when the owner that
   * attached `token` is gone. Browser: a pending request on the owner's own Web
   * Lock, granted the moment its worker/tab dies. Node: worker "exit".
   */
  watchOwner?: (shard: number, token: unknown) => Promise<unknown>;
}

/** Thrown into in-flight requests of a shard whose owner is gone (CF: "Durable Object reset"). */
export class ShardOwnerLostError extends Error {
  constructor(shard: number) {
    super(`Owner of cell shard ${shard} was lost; the request may or may not have been applied`);
    this.name = "ShardOwnerLostError";
  }
}

interface Link {
  send: Send;
  token: unknown;
  inflight: Set<AbortController>;
}

/**
 * The single "server" of an origin (ServiceWorker, page or Node main thread):
 * knows which shard owns which cell and holds one HTTP link per shard worker.
 *
 * - `ingress(req)`: public requests → any live shard's Worker `fetch`. Control
 *   headers are stripped first, so clients cannot address objects directly.
 * - `internal(req)`: requests from shard workers (DO → DO across shards) →
 *   forwarded to the owning shard, control headers intact.
 */
export class CellRouter {
  readonly #opts: CellRouterOptions;
  readonly #links = new Map<number, Link>();
  #watchdog: ReturnType<typeof setInterval> | undefined;
  readonly #waiters = new Map<number, (() => void)[]>();
  #rr = 0;

  constructor(opts: CellRouterOptions) {
    this.#opts = opts;
  }

  get attachedShards(): number[] {
    return [...this.#links.keys()].sort((a, b) => a - b);
  }

  /**
   * Attaches the link of a shard. Replacing a link means the previous owner is
   * gone (Web Locks / leases guarantee a single live owner): its in-flight
   * requests fail at once instead of hanging on a dead port.
   */
  attach(shard: number, send: Send, token?: unknown): void {
    const prev = this.#links.get(shard);
    this.#links.set(shard, { send, token, inflight: new Set() });
    if (prev) this.#fail(shard, prev);
    if (token !== undefined && this.#opts.watchOwner)
      this.#opts.watchOwner(shard, token).then(
        () => this.#links.get(shard)?.token === token && this.detach(shard),
        () => {},
      );
    for (const wake of this.#waiters.get(shard) ?? []) wake();
    this.#waiters.delete(shard);
  }

  detach(shard: number, send?: Send): void {
    const link = this.#links.get(shard);
    if (!link || (send && link.send !== send)) return;
    this.#links.delete(shard);
    this.#fail(shard, link);
  }

  /** Number of requests currently forwarded to a shard (diagnostics/tests). */
  inflight(shard: number): number {
    return this.#links.get(shard)?.inflight.size ?? 0;
  }

  #fail(shard: number, link: Link): void {
    for (const ac of link.inflight) ac.abort(new ShardOwnerLostError(shard));
    link.inflight.clear();
  }

  /** Forwards with an abort handle; the handle lives until the response body ends. */
  async #forward(shard: number, req: Request): Promise<Response> {
    const link = await this.#linkFor(shard);
    const ac = new AbortController();
    link.inflight.add(ac);
    this.#ensureWatchdog();
    const done = () => link.inflight.delete(ac);
    const lost = new Promise<never>((_, reject) =>
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true }),
    );
    lost.catch(() => {});
    try {
      const signal = AbortSignal.any([req.signal, ac.signal]);
      const res = await Promise.race([
        link.send(new Request(req, { signal, duplex: "half" } as RequestInit)),
        lost,
      ]);
      if (!res.body) return done(), res;
      const { readable, writable } = new TransformStream();
      res.body.pipeTo(writable, { signal: ac.signal }).then(done, done);
      return new Response(readable, res);
    } catch (e) {
      done();
      throw ac.signal.aborted ? ac.signal.reason : e;
    }
  }

  #ensureWatchdog(): void {
    if (this.#watchdog || !this.#opts.isAlive) return;
    this.#watchdog = setInterval(async () => {
      const busy = [...this.#links].filter(([, l]) => l.inflight.size > 0);
      if (!busy.length) {
        clearInterval(this.#watchdog);
        this.#watchdog = undefined;
        return;
      }
      for (const [shard, link] of busy) {
        const alive = await this.#opts.isAlive!(shard, link.token).catch(() => true);
        if (!alive && this.#links.get(shard) === link) this.detach(shard);
      }
    }, this.#opts.livenessIntervalMs ?? 1000);
  }

  ingress = async (req: Request): Promise<Response> => {
    const live = this.attachedShards;
    const shard = live.length ? live[this.#rr++ % live.length] : 0;
    try {
      return await this.#forward(shard, stripControl(req));
    } catch (e) {
      return new Response(`Cell shard ${shard} unavailable: ${(e as Error).message}`, {
        status: 503,
      });
    }
  };

  internal = async (req: Request): Promise<Response> => {
    const kind = req.headers.get(H.kind);
    try {
      if (kind === "describe") return Response.json({ bindings: this.#opts.bindings });
      if (kind !== "fetch" && kind !== "rpc") return await this.ingress(req);
      return await this.#forward(this.shardOfRequest(req), req);
    } catch (e) {
      return errorResponse(e, 503);
    }
  };

  shardOfRequest(req: Request): number {
    const binding = req.headers.get(H.binding) ?? "";
    const target = req.headers.get(H.target) ?? "";
    const className = this.#opts.bindings[binding];
    if (!className) throw new Error(`Unknown Durable Object binding "${binding}"`);
    const hex = target.startsWith("name:")
      ? idFromName(className, target.slice(5)).toString()
      : target.slice(3);
    return shardOf(hex, this.#opts.shards);
  }

  async #linkFor(shard: number): Promise<Link> {
    const link = this.#links.get(shard);
    if (link) return link;
    this.#opts.onMissingShard?.(shard);
    const timeout = this.#opts.attachTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`shard ${shard} not attached within ${timeout} ms`)),
        timeout,
      );
      const list = this.#waiters.get(shard) ?? [];
      list.push(() => (clearTimeout(t), resolve()));
      this.#waiters.set(shard, list);
    });
    return this.#links.get(shard)!;
  }
}
