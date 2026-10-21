/**
 * Globals of the Workers runtime that browsers/Node lack or implement differently,
 * substituted into user bundles (esbuild `inject` on the server, webrun-modules `~deps`
 * in the browser) — the real globals are untouched. "webrun-cells:ws" is resolved as an
 * EXTERNAL module (src/ws/server.ts): if it were bundled, the injected `Response` would
 * also replace the `Response` that CellsResponse itself extends.
 */
// @ts-expect-error — virtual specifier resolved by the bundler plugin
export { CellsResponse as Response, caches, WebSocketPair } from "webrun-cells:ws";
