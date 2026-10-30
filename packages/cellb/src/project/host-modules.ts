/**
 * What a bundler other than `bundleWorkerForBrowser` needs to build a Worker that runs in
 * cellb's browser realm (webrun-bundler in a browser, for one): the sources of the modules the
 * runtime provides, by specifier, and the module whose exports replace the Workers globals.
 *
 * - `cloudflare:workers`: the runtime's classes, and the project's `env`, `exports` and
 *   `waitUntil` (`globalThis.__cellsProjectScope`).
 * - `node:*` (nodejs_compat): cellb's polyfills, read from `globalThis.__cellsNodeModules`,
 *   which `browserProjectRuntime` sets; every name the polyfill exports is a named export.
 * - `cells:globals` (to inject): `Request`, `Response`, `WebSocketPair`… of the runtime.
 *
 * The bundle should lower `await` (AsyncLocalStorage follows promise continuations).
 */
import { nodeRegistryEntries } from "../node-compat/browser-registry.js";
import { PROJECT_WORKERS_MODULE_SHIM } from "./browser-modules.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

export const NODE_MODULES_GLOBAL = "__cellsNodeModules";
export const CELLS_GLOBALS_MODULE = "cells:globals";

const IDENT = /^[A-Za-z_$][\w$]*$/;

function nodeModuleSource(spec: string): string | undefined {
  const name = spec.startsWith("node:") ? spec : `node:${spec}`;
  if (!Object.hasOwn(nodeRegistryEntries, name)) return undefined;
  const entry = nodeRegistryEntries[name] as Record<string, unknown>;
  const names = Object.keys(entry).filter((k) => k !== "default" && IDENT.test(k));
  const m = `globalThis.${NODE_MODULES_GLOBAL}[${JSON.stringify(name)}]`;
  return `const m = ${m}; export default m.default ?? m;${names.length ? ` export const { ${names.join(", ")} } = m;` : ""}`;
}

/** The source of a module the runtime provides, or `undefined`. */
export function cellbHostModule(spec: string): string | undefined {
  if (spec === "cloudflare:workers") return PROJECT_WORKERS_MODULE_SHIM;
  if (spec === CELLS_GLOBALS_MODULE)
    return `${WORKERS_GLOBAL_NAMES.map((n) => `export const ${n} = globalThis.__cellsGlobals?.${n} ?? globalThis.${n};`).join(" ")} export const scheduler = ${SCHEDULER_EXPRESSION};`;
  if (spec.startsWith("node:")) return nodeModuleSource(spec);
  return undefined;
}
