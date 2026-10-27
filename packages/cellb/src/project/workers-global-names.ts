/**
 * The Workers globals substituted into browser bundles (`scheduler` aside, which is an
 * expression): each is read from the realm that runs the code. workers-globals.ts spells the
 * same list as static re-exports, because esbuild `inject` needs a literal module.
 */
export const WORKERS_GLOBAL_NAMES = [
  "Request",
  "Response",
  "WebSocketPair",
  "caches",
  "HTMLRewriter",
  "WebSocketRequestResponsePair",
  "WebSocket",
] as const;
