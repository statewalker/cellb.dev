import { type CellRuntime, type CellRuntimeOptions, createCellRuntime } from "../core/runtime.js";
import { shardOf } from "../core/shard.js";
import { H, keepUpgrade, type Send } from "../transport/cells-link.js";
import { type CellPort, linkOverPort, serveRuntime } from "../transport/port.js";
import { type ControlMessage, type ControlPort, PortRendezvous } from "../ws/control.js";
import { CellsResponse, CfWebSocket } from "../ws/server.js";

export interface ShardWorkerOptions extends Omit<CellRuntimeOptions, "route"> {
  shard: number;
  shards: number;
}

export interface ShardWorker {
  readonly runtime: CellRuntime;
  /**
   * (Re)connects to a router: `down` = router → shard (served here),
   * `up` = shard → router (for DO calls into other shards), `ctl` = control
   * channel for WebSocket port hand-over. Called again when the router restarts
   * (a ServiceWorker is killed when idle and loses its ports).
   */
  link(down: CellPort, up: CellPort, ctl?: ControlPort): Promise<void>;
  /**
   * Drops the links of a router that is gone (a stopped ServiceWorker leaves no trace on its
   * ports): calls into other shards wait for the next `link`, and `onUnlinked` is told so.
   */
  unlink(): void;
}

/** Runs one shard: hosts the cells of shard `shard`, forwards the others upstream. */
export function createShardWorker(opts: ShardWorkerOptions): ShardWorker {
  const shard = shardRouting(opts);
  const runtime = createCellRuntime({
    ...opts,
    vars: { ...opts.vars, SHARD: opts.shard },
    route: shard.route,
  });
  return shard.attach(runtime);
}

/**
 * The router side of a shard, for a runtime built elsewhere (a project's, in a browser worker):
 * `route` sends the cells of other shards up to the router (waiting until it is linked);
 * `attach(runtime)` gives the runtime its links to the router.
 */
export function shardRouting(opts: {
  shard: number;
  shards: number;
  /** A call into another shard waits after `unlink`: wake the router (once per `unlink`). */
  onUnlinked?: () => void;
  /**
   * Called every `keepAliveMs` (default 20 s) while calls into other shards are in flight: they
   * are no events for the router's ServiceWorker, which the browser stops when idle (~30 s).
   */
  keepAlive?: () => void;
  keepAliveMs?: number;
}): {
  route: NonNullable<CellRuntimeOptions["route"]>;
  attach(runtime: CellRuntime): ShardWorker;
} {
  let upstream: Send | undefined;
  let control: ControlPort | undefined;
  const pending: (() => void)[] = [];
  const ports = new PortRendezvous();
  let wsSeq = 0;
  let unlinked = false;
  let wokeAt = 0;
  let outstanding = 0; // calls into other shards in flight
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  const started = () => {
    if (outstanding++ === 0 && opts.keepAlive)
      keepAliveTimer = setInterval(opts.keepAlive, opts.keepAliveMs ?? 20_000);
  };
  const finished = () => {
    if (--outstanding === 0) clearInterval(keepAliveTimer);
  };
  /** Calls in flight over the current links: a dead link never answers them. */
  let inflight = new Set<(err: Error) => void>();
  const dropInflight = () => {
    const lost = inflight;
    inflight = new Set();
    const err = new Error(
      "The router was lost while this call was in flight; it may or may not have been applied",
    );
    for (const fail of lost) fail(err);
  };

  const rawUp: Send = async (req) => {
    // Woken once per unlink, again if the router is still not back after a while.
    if (!upstream && unlinked && Date.now() - wokeAt > 2_000) {
      wokeAt = Date.now();
      opts.onUnlinked?.();
    }
    while (!upstream) await new Promise<void>((r) => pending.push(r));
    const send = upstream;
    const calls = inflight;
    started();
    return new Promise<Response>((resolve, reject) => {
      calls.add(reject);
      send(req)
        .then(resolve, reject)
        .finally(() => calls.delete(reject));
    }).finally(finished);
  };
  // DO → DO calls into other shards. A WebSocket upgrade gets an id; the owning
  // shard hands the socket's port over the control channel (via the router).
  const up: Send = async (req) => {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return rawUp(req);
    const id = `s${opts.shard}:${++wsSeq}`;
    const headers = new Headers(req.headers);
    headers.set(H.ws, id);
    headers.set(H.upgrade, "websocket"); // hop-by-hop `Upgrade` does not survive the HTTP/1.1 link
    const offered = req.headers.get("Sec-WebSocket-Protocol"); // forbidden in browser Requests
    if (offered) headers.set(H.wsProtocol, offered);
    const res = await rawUp(new Request(req.url, { method: req.method, headers }));
    if (res.headers.get(H.wsAccepted) !== id) return res; // refused upgrade (plain HTTP answer)
    const { port, protocol } = await ports.wait(id);
    return new CellsResponse(null, {
      status: 101,
      webSocket: new CfWebSocket(port),
      headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
    });
  };

  // The owner travels with the request: the router need not derive it (it cannot for a
  // project's internal namespaces, whose ids come from other keys).
  const route = (_key: string, id: { toString(): string }): Send | undefined => {
    const owner = shardOf(id.toString(), opts.shards);
    if (owner === opts.shard) return undefined;
    return (req) => {
      const headers = new Headers(req.headers);
      headers.set(H.shard, String(owner));
      return up(keepUpgrade(req, new Request(req, { headers })));
    };
  };
  let runtime!: CellRuntime;

  const post = (m: ControlMessage) =>
    control?.postMessage(m, m.t === "ws-accept" ? [m.port as unknown as Transferable] : []);
  const onControl = async (e: MessageEvent) => {
    const m = e.data as ControlMessage;
    if (m.t === "ws-accept") return ports.deliver(m.id, { port: m.port, protocol: m.protocol });
    if (m.t === "ws-refuse") return ports.deliver(m.id, new Error(m.message));
    if (m.t === "ws-connect") {
      try {
        const { port, protocol } = await runtime.connectWebSocket(m.url, m.protocols, m.headers);
        post({ t: "ws-accept", id: m.id, protocol, port });
      } catch (err) {
        post({ t: "ws-refuse", id: m.id, message: String((err as Error)?.message ?? err) });
      }
    }
  };

  let stopDown: (() => Promise<void>) | undefined;
  let closeUp: (() => Promise<void>) | undefined;
  const attach = (rt: CellRuntime): ShardWorker => {
    runtime = rt;
    return {
      runtime,
      link,
      unlink() {
        if (!upstream) return;
        upstream = undefined;
        unlinked = true;
        wokeAt = 0;
        dropInflight();
        const [prevStop, prevClose] = [stopDown, closeUp];
        stopDown = closeUp = undefined;
        void Promise.allSettled([prevStop?.(), prevClose?.()]);
      },
    };
  };
  const link: ShardWorker["link"] = async (down, upPort, ctl) => {
    const [prevStop, prevClose] = [stopDown, closeUp];
    if (ctl) {
      control = ctl;
      ctl.onmessage = (e) => void onControl(e);
      ctl.start?.();
    }
    stopDown = await serveRuntime(down, runtime, {
      // A Worker in another shard opened a socket to one of our objects.
      onUpgrade: (id, port, protocol) => post({ t: "ws-accept", id, protocol, port }),
    });
    const l = await linkOverPort(upPort);
    closeUp = l.close;
    // A new router: the previous one is gone, and so are the answers to calls sent to it.
    if (upstream) dropInflight();
    upstream = l.send;
    unlinked = false;
    for (const w of pending.splice(0)) w();
    await Promise.allSettled([prevStop?.(), prevClose?.()]);
  };
  return { route, attach };
}
