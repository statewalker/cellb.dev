import { type CellRuntime, type CellRuntimeOptions, createCellRuntime } from "../core/runtime.js";
import { shardOf } from "../core/shard.js";
import { H, type Send } from "../transport/cells-http.js";
import { type CellPort, linkOverPort, serveRuntime } from "../transport/port.js";
import { type ControlMessage, type ControlPort, PortRendezvous } from "../ws/control.js";
import { CellsResponse, CfWebSocket } from "../ws/server.js";

export interface ShardHostOptions extends Omit<CellRuntimeOptions, "route"> {
  shard: number;
  shards: number;
}

export interface ShardHost {
  readonly runtime: CellRuntime;
  /**
   * (Re)connects to a router: `down` = router → shard (served here),
   * `up` = shard → router (for DO calls into other shards), `ctl` = control
   * channel for WebSocket port hand-over. Called again when the router restarts
   * (a ServiceWorker is killed when idle and loses its ports).
   */
  link(down: CellPort, up: CellPort, ctl?: ControlPort): Promise<void>;
}

/** Runs one shard: hosts the cells of shard `shard`, forwards the others upstream. */
export function createShardHost(opts: ShardHostOptions): ShardHost {
  let upstream: Send | undefined;
  let control: ControlPort | undefined;
  const pending: (() => void)[] = [];
  const ports = new PortRendezvous();
  let wsSeq = 0;

  const rawUp: Send = async (req) => {
    while (!upstream) await new Promise<void>((r) => pending.push(r));
    return upstream(req);
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

  const runtime = createCellRuntime({
    ...opts,
    vars: { ...opts.vars, SHARD: opts.shard },
    route: (_key, id) => (shardOf(id.toString(), opts.shards) === opts.shard ? undefined : up),
  });

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
  return {
    runtime,
    async link(down, upPort, ctl) {
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
      upstream = l.send;
      for (const w of pending.splice(0)) w();
      await Promise.allSettled([prevStop?.(), prevClose?.()]);
    },
  };
}
