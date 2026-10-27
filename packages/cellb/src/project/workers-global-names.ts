import { SCHEDULER_EXPRESSION } from "./scheduler.js";

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

/**
 * A module exporting the Workers globals from `globalThis.__cellsGlobals` (esbuild `inject`
 * for bundles whose realm sets them: a browser project, a loaded Worker's Node thread).
 */
export const GLOBALS_SHIM = `${WORKERS_GLOBAL_NAMES.map((n) => `export const ${n} = globalThis.__cellsGlobals.${n};`).join(" ")} export const scheduler = ${SCHEDULER_EXPRESSION};`;
