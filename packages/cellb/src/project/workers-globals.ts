/**
 * Globals of the Workers runtime that browsers/Node lack or implement differently,
 * substituted into user bundles (esbuild `inject` on the server, webrun-modules `~deps`
 * in the browser) — the real globals are untouched. "cellb:ws" is resolved as an
 * EXTERNAL module (workers-globals-module.ts): if it were bundled, the injected `Response` would
 * also replace the `Response` that CellsResponse itself extends.
 */
import { standardBinaryType } from "cellb:compat";
import { WebSocketPair as LegacyWebSocketPair, StandardWebSocketPair } from "cellb:ws";

export {
  CellsRequest as Request,
  CellsResponse as Response,
  caches,
  HTMLRewriter,
  WebSocket,
  WebSocketRequestResponsePair,
} from "cellb:ws";

/** The project's `websocket_standard_binary_type` flag ("cellb:compat", one per bundle). */
export const WebSocketPair = standardBinaryType ? StandardWebSocketPair : LegacyWebSocketPair;

/** workerd's `MessageChannel`: an idle port does not keep the Node host alive. */
export { WorkerdMessageChannel as MessageChannel } from "./workerd-message-channel.js";

/** workerd's `scheduler`:`await scheduler.wait(ms)` is a promise-based setTimeout. */
export const scheduler = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
