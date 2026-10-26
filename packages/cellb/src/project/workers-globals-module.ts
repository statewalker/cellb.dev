/**
 * The "cellb:ws" module that workers-globals.ts imports: the runtime's own
 * Workers globals, loaded as an external module so user bundles share these instances.
 */
export { cellsCaches as caches } from "../bindings/cache.js";
export { HTMLRewriter } from "../bindings/html-rewriter.js";

import { CfWebSocket } from "../ws/server.js";
import { carryWebSocketHeaders } from "../ws/upgrade.js";

export {
  CellsResponse,
  StandardWebSocketPair,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../ws/server.js";

/**
 * workerd's global `WebSocket`: one class for both ends of a pair, so `instanceof WebSocket`,
 * `WebSocket.READY_STATE_*` and `WebSocket.prototype.deserializeAttachment.call(ws)` (how
 * partyserver reads attachments) see the server end's class. `new WebSocket(url)` still makes
 * the host's client WebSocket.
 */
export const WorkersWebSocket = new Proxy(CfWebSocket, {
  construct: (_target, args) => Reflect.construct(globalThis.WebSocket, args),
});

/**
 * `Request` for Worker code in browsers. A browser's `Request` drops `Upgrade` and
 * `Sec-WebSocket-*` (forbidden headers); workerd's keeps them, so code that rebuilds a
 * WebSocket request (partyserver's routing adds its own headers) still upgrades. Node's
 * `Request` keeps them already.
 */
export class CellsRequest extends Request {
  /** The runtime hands Worker code plain `Request`s: `instanceof Request` must hold for them. */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Request;
  }
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    const given = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    carryWebSocketHeaders(new Headers(given), this);
  }
  /** A browser's `clone()` makes a plain `Request` from the guarded headers. */
  override clone(): Request {
    return new CellsRequest(super.clone(), { headers: this.headers });
  }
}
