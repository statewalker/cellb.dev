/**
 * The "cellb:ws" module that workers-globals.ts imports: the runtime's own
 * Workers globals, loaded as an external module so user bundles share these instances.
 */
export { cellsCaches as caches } from "../bindings/cache.js";
export { HTMLRewriter } from "../bindings/html-rewriter.js";

import { CfWebSocket } from "../ws/server.js";

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
