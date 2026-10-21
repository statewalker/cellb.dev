import { CellsCloseEvent, checkClose, type Frame, toFrameData } from "./frames.js";

const kPort = Symbol("webrun-cells.ws.port");

/**
 * Cloudflare Workers' server-side WebSocket (one end of a WebSocketPair):
 * events are delivered only after `accept()`; `send`/`close` as in workerd.
 * Hibernation (`ctx.acceptWebSocket`) is a later prototype.
 */
export class CfWebSocket extends EventTarget {
  static readonly READY_STATE_CONNECTING = 0;
  static readonly READY_STATE_OPEN = 1;
  static readonly READY_STATE_CLOSING = 2;
  static readonly READY_STATE_CLOSED = 3;
  readyState = 1;
  url: string | null = null;

  protocol: string | null = null;
  extensions: string | null = null;
  [kPort]: MessagePort | undefined;
  #accepted = false;
  #queued: Frame[] = [];
  #attachment: unknown;

  #lastPing = 0;
  #watch: ReturnType<typeof setInterval> | undefined;

  constructor(port: MessagePort) {
    super();
    this[kPort] = port;
    port.onmessage = (e) => {
      const f = e.data as Frame;
      if (f.t === "p") return this.#ping(f.hb); // answered even before accept()
      if (this.#accepted) this.#frame(f);
      else this.#queued.push(f);
    };
  }

  /** Heartbeat: answer the client's ping; close 1006 when pings stop for 3 periods. */
  #ping(hb: number): void {
    this.#lastPing = Date.now();
    this[kPort]?.postMessage({ t: "q" } satisfies Frame);
    if (this.#watch || !hb) return;
    this.#watch = setInterval(() => {
      if (this.readyState === 3) return clearInterval(this.#watch);
      if (Date.now() - this.#lastPing > 3 * hb) this.#gone();
    }, hb);
  }

  /** The client stopped pinging (tab closed, worker killed): abnormal closure. */
  #gone(): void {
    clearInterval(this.#watch);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this[kPort]?.close();
    this.dispatchEvent(new CellsCloseEvent("close", { code: 1006, reason: "", wasClean: false }));
  }

  /** The other end of the WebSocketPair (the runtime checks how the server end was accepted). */
  peer?: CfWebSocket;
  /** Accepted through ctx.acceptWebSocket() (hibernatable) rather than accept(). */
  hibernatable = false;
  get accepted(): boolean {
    return this.#accepted;
  }

  accept(): void {
    if (this.#accepted) return;
    if (!this[kPort])
      throw new TypeError("This WebSocket end was handed to a client; it cannot be accepted.");
    this.#accepted = true;
    this[kPort].start?.();
    for (const f of this.#queued.splice(0)) this.#frame(f);
  }

  serializeAttachment(v: unknown): void {
    this.#attachment = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment);
  }

  #frame(f: Frame): void {
    if (f.t === "m") {
      this.dispatchEvent(new MessageEvent("message", { data: f.d }));
      return;
    }
    if (f.t !== "c") return;
    const wasOpen = this.readyState === 1;
    if (wasOpen)
      this[kPort]!.postMessage({ t: "c", code: f.code, reason: f.reason } satisfies Frame);
    this.readyState = 3;
    clearInterval(this.#watch);
    this[kPort]!.close();
    this.dispatchEvent(
      new CellsCloseEvent("close", { code: f.code, reason: f.reason, wasClean: true }),
    );
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this.#accepted)
      throw new TypeError("You must call accept() on this WebSocket before sending messages.");
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    const d = toFrameData(data);
    this[kPort]!.postMessage({ t: "m", d } satisfies Frame, typeof d === "string" ? [] : [d]);
  }

  close(code?: number, reason?: string): void {
    checkClose(code, reason);
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this[kPort]!.postMessage({ t: "c", code: code ?? 1005, reason: reason ?? "" } satisfies Frame);
  }
}

/** `new WebSocketPair()` → `{ 0: client, 1: server }`, entangled over a MessageChannel. */
export class WebSocketPair {
  0: CfWebSocket;
  1: CfWebSocket;
  constructor() {
    const { port1, port2 } = new MessageChannel();
    this[0] = new CfWebSocket(port1);
    this[1] = new CfWebSocket(port2);
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

/**
 * Detaches the transport of the CLIENT end returned in a 101 response, so the
 * runtime can hand the raw MessagePort to the real client (transferable).
 */
export function takeClientPort(ws: CfWebSocket): MessagePort {
  const port = ws[kPort];
  if (!port) throw new TypeError("WebSocket end already handed over");
  ws[kPort] = undefined;
  port.onmessage = null;
  ws.readyState = 3; // handed over: this end must not answer pings any more
  return port;
}

/**
 * `Response` that also accepts Cloudflare's `{ status: 101, webSocket }` init —
 * the platform `Response` rejects status 101. Provided to user code via ~deps.
 */
export class CellsResponse extends Response {
  readonly #status: number;
  readonly webSocket: CfWebSocket | null;
  constructor(
    body?: BodyInit | null,
    init: ResponseInit & { webSocket?: CfWebSocket | null } = {},
  ) {
    const upgrade = init.status === 101;
    super(upgrade ? null : body, { ...init, status: upgrade ? 200 : init.status });
    this.#status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
  }
  get status(): number {
    // Static helpers (CellsResponse.json(), .redirect(), .error()) may build instances
    // without running this constructor: fall back to the platform's status.
    return #status in this ? this.#status : super.status;
  }
}

/** Workers `caches` (always-miss, as celld) — exported here so user bundles get it with Response. */
export { cellsCaches as caches } from "../bindings/cache.js";
