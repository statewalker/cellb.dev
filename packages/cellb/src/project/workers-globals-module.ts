/**
 * The "cellb:ws" module that workers-globals.ts imports: the runtime's own
 * Workers globals, loaded as an external module so user bundles share these instances.
 */
import { cellsCaches as caches } from "../bindings/cache.js";
import { HTMLRewriter } from "../bindings/html-rewriter.js";
import {
  CellsResponse,
  StandardWebSocketPair,
  WorkersWebSocket as WebSocket,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../ws/server.js";
import { CellsRequest } from "../ws/upgrade.js";

export {
  CellsRequest,
  CellsResponse,
  caches,
  HTMLRewriter,
  StandardWebSocketPair,
  WebSocket,
  WebSocketPair,
  WebSocketRequestResponsePair,
};

/**
 * The Workers globals of Worker code with these compatibility flags, by their global names
 * (`WORKERS_GLOBAL_NAMES`): `WebSocketPair` follows `websocket_standard_binary_type`.
 */
export function workersGlobalsFor(flags: readonly string[] = []) {
  return {
    Request: CellsRequest,
    Response: CellsResponse,
    WebSocketPair: flags.includes("websocket_standard_binary_type")
      ? StandardWebSocketPair
      : WebSocketPair,
    caches,
    HTMLRewriter,
    WebSocketRequestResponsePair,
    WebSocket,
  };
}
