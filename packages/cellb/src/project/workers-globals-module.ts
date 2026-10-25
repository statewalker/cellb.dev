/**
 * The "cellb:ws" module that workers-globals.ts imports: the runtime's own
 * Workers globals, loaded as an external module so user bundles share these instances.
 */
export { cellsCaches as caches } from "../bindings/cache.js";
export { HTMLRewriter } from "../bindings/html-rewriter.js";
export { CellsResponse, WebSocketPair, WebSocketRequestResponsePair } from "../ws/server.js";
