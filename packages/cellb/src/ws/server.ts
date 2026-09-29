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

  constructor(port: MessagePort) {
    super();
    this[kPort] = port;
    port.onmessage = (e) => (this.#accepted ? this.#frame(e.data) : this.#queued.push(e.data));
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
    const wasOpen = this.readyState === 1;
    if (wasOpen)
      this[kPort]!.postMessage({ t: "c", code: f.code, reason: f.reason } satisfies Frame);
    this.readyState = 3;
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
    return this.#status;
  }
}
