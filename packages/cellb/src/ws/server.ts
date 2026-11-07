import { ServerWebSocket } from "@statewalker/webrun-http-browser/sw";
import { checkClose } from "./frames.js";

/** Server ends accepted in this realm and not yet closed (see `CfWebSocket.goAway`). */
const acceptedEnds = new Set<CfWebSocket>();

/**
 * Cloudflare Workers' server-side WebSocket (one end of a WebSocketPair), on
 * webrun-http-browser's `ServerWebSocket` and its frames, with workerd's semantics:
 *
 * - events only after `accept()` (frames that arrive earlier wait), and either end may `send()`
 *   before it (celld does; the frames wait in the port);
 * - `close()` with no code sends 1005 and waits for the echo however long; the codes Worker code
 *   may send are 1000 and 3000–4999; messages in flight when `close()` was called still arrive;
 * - the heartbeat watch starts with the client's first ping and keeps that period: a pair's ends
 *   used in one realm never ping, and a tab that closes turns hidden (announcing a longer period)
 *   on its way out;
 * - attachments, `peer`, `hibernatable`, and `goAway` for the ends accepted in this realm.
 *
 * Hibernation (`ctx.acceptWebSocket`) is a later prototype.
 */
export class CfWebSocket extends ServerWebSocket {
  static readonly READY_STATE_CONNECTING = 0;
  static readonly READY_STATE_OPEN = 1;
  static readonly READY_STATE_CLOSING = 2;
  static readonly READY_STATE_CLOSED = 3;
  extensions: string | null = null;
  #attachment: unknown;

  constructor(port: MessagePort) {
    super(port, {
      watch: "first-ping",
      heartbeatPeriod: "first",
      sendBeforeAccept: true,
      deliverWhileClosing: true,
      defaultCloseCode: 1005,
      closeTimeoutMs: Number.POSITIVE_INFINITY,
    });
    // workerd's server ends have no url or subprotocol of their own.
    Object.defineProperty(this, "url", { value: null, writable: true, configurable: true });
    Object.defineProperty(this, "protocol", { value: null, writable: true, configurable: true });
  }

  /** The other end of the WebSocketPair (the runtime checks how the server end was accepted). */
  peer?: CfWebSocket;
  /** Accepted through ctx.acceptWebSocket() (hibernatable) rather than accept(). */
  hibernatable = false;

  override accept(): void {
    if (this.accepted) return;
    try {
      super.accept();
    } catch {
      throw new TypeError("This WebSocket end was handed to a client; it cannot be accepted.");
    }
    acceptedEnds.add(this);
  }

  override send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) throw new TypeError("Can't call WebSocket send() after close().");
    super.send(data);
  }

  protected override checkClose(code: number | undefined, reason: string | undefined): void {
    checkClose(code, reason);
  }

  protected override _onClosed(): void {
    acceptedEnds.delete(this);
    super._onClosed();
  }

  serializeAttachment(v: unknown): void {
    this.#attachment = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment);
  }

  /**
   * Closes every server end accepted in this realm with 1001 (going away). A shard worker that
   * hands its cells to another tab does it before it stops, so that clients reconnect at once
   * instead of noticing through the heartbeat; Worker code cannot send 1001 itself (`close`).
   */
  static goAway(reason = "moving to another worker"): void {
    for (const ws of acceptedEnds) {
      acceptedEnds.delete(ws);
      if (ws.readyState >= 2) continue;
      ws._startClose(1001, reason);
    }
  }
}

/** The host's own WebSocket (Node's, or the browser's): the client sockets Worker code opens. */
const HostWebSocket = (
  globalThis as { WebSocket?: new (url: string, p?: string | string[]) => object }
).WebSocket;

/**
 * The `WebSocket` global of Worker code. On workerd one class covers both ends of a
 * WebSocketPair and the client sockets `new WebSocket(url)` opens, and libraries rely on that:
 * the Agents SDK (partyserver) reads attachments with
 * `WebSocket.prototype.deserializeAttachment.call(ws)` and compares `readyState` with
 * `WebSocket.READY_STATE_OPEN`. So its prototype is the server end's (`CfWebSocket`), its
 * statics are workerd's, `instanceof` holds for both kinds, and `new WebSocket(url)` still opens
 * the host's client socket.
 */
export const WorkersWebSocket = (() => {
  function WebSocket(this: unknown, url: string, protocols?: string | string[]): object {
    if (!new.target)
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    if (!HostWebSocket) throw new Error("WebSocket clients are not available in this realm.");
    return new HostWebSocket(url, protocols);
  }
  WebSocket.prototype = CfWebSocket.prototype;
  const states = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;
  for (const [name, value] of Object.entries(states)) {
    Object.defineProperty(WebSocket, name, { value, enumerable: true });
    Object.defineProperty(WebSocket, `READY_STATE_${name}`, { value, enumerable: true });
  }
  Object.defineProperty(WebSocket, Symbol.hasInstance, {
    value: (v: unknown) =>
      v instanceof CfWebSocket || (HostWebSocket !== undefined && v instanceof HostWebSocket),
  });
  return WebSocket as unknown as typeof CfWebSocket & {
    new (url: string, protocols?: string | string[]): CfWebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
})();

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
  /** `const [client, server] = new WebSocketPair()`, as in workerd. */
  *[Symbol.iterator](): IterableIterator<CfWebSocket> {
    yield this[0];
    yield this[1];
  }
}

/**
 * `WebSocketPair` under the `websocket_standard_binary_type` compatibility flag: both ends
 * start with `binaryType` "blob", as browsers' WebSockets do. Without it they start with
 * "arraybuffer", workerd's older default.
 */
export class StandardWebSocketPair extends WebSocketPair {
  constructor() {
    super();
    this[0].binaryType = "blob";
    this[1].binaryType = "blob";
  }
}

/**
 * Detaches the transport of the CLIENT end returned in a 101 response, so the
 * runtime can hand the raw MessagePort to the real client (transferable).
 */
export function takeClientPort(ws: CfWebSocket): MessagePort {
  // Frames the server sent before the response was handed over (partyserver greets in
  // onConnect, before it returns the 101) reached this end and wait in its queue: the new holder
  // gets them first, then the rest (ServerWebSocket.detach).
  try {
    return ws.detach();
  } catch {
    throw new TypeError("WebSocket end already handed over");
  }
}

/**
 * `Response` that also accepts Cloudflare's `{ status: 101, webSocket }` init —
 * the platform `Response` rejects status 101. Provided to user code via ~deps.
 */
/** The platform `Response`, as this module sees it (it is external to user bundles). */
const HostResponse = Response;

/** Browsers drop `Set-Cookie` from every Response they build (Node keeps it). */
const dropsSetCookie = !new HostResponse(null, { headers: { "set-cookie": "a=b" } }).headers.has(
  "set-cookie",
);

export class CellsResponse extends Response {
  readonly #status: number;
  readonly webSocket: CfWebSocket | null;
  constructor(
    body?: BodyInit | null,
    init: ResponseInit & { webSocket?: CfWebSocket | null } = {},
  ) {
    const upgrade = init.status === 101;
    // The init's members read one by one, as Fetch reads a dictionary: an init that is itself a
    // Response (`new Response(body, response)`, as opencode's SDK does) keeps its headers and
    // statusText, which a spread would drop (they are getters on its prototype).
    super(upgrade ? null : body, {
      status: upgrade ? 200 : init.status,
      statusText: init.statusText,
      headers: init.headers,
    });
    this.#status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
    if (dropsSetCookie) {
      // In a browser the platform's headers drop `Set-Cookie`, which Workers set (Astro appends
      // its cookies to the response): the response keeps its headers in a standalone `Headers`,
      // the ones the platform derived (content-type) plus the Set-Cookie values of the init.
      const headers = new Headers(super.headers);
      const given = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      for (const c of given.getSetCookie()) headers.append("set-cookie", c);
      Object.defineProperty(this, "headers", {
        value: headers,
        configurable: true,
        enumerable: true,
      });
    }
  }
  get status(): number {
    // Static helpers (CellsResponse.json(), .redirect(), .error()) may build instances
    // without running this constructor: fall back to the platform's status.
    return #status in this ? this.#status : super.status;
  }

  /**
   * Every platform `Response` is a Workers `Response`, as on workerd: `Response.json()`,
   * `Response.redirect()` and `Response.error()` (the platform's static helpers, which build
   * platform instances, not instances of this subclass) and `fetch()` results pass
   * `instanceof Response` in Worker code. Astro checks every endpoint's result that way.
   */
  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof HostResponse;
  }

  // In a browser the platform's static helpers build platform responses, whose headers drop
  // `Set-Cookie`: these build instances of this class there (`Response.json()` is how most
  // APIs answer, and their cookies are appended to it afterwards).
  static override json(data: unknown, init: ResponseInit = {}): Response {
    if (!dropsSetCookie) return super.json(data, init);
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new CellsResponse(JSON.stringify(data), { ...init, headers });
  }

  static override redirect(url: string | URL, status = 302): Response {
    if (!dropsSetCookie) return super.redirect(url, status);
    if (![301, 302, 303, 307, 308].includes(status))
      throw new RangeError(`Invalid status ${status}`);
    const base = (globalThis as { location?: { href: string } }).location?.href;
    return new CellsResponse(null, { status, headers: { location: new URL(url, base).href } });
  }
}

/** Workers `WebSocketRequestResponsePair` (ctx.setWebSocketAutoResponse). */
export class WebSocketRequestResponsePair {
  readonly request: string;
  readonly response: string;
  constructor(request: string, response: string) {
    this.request = request;
    this.response = response;
  }
}
