/**
 * Node side of a browser-hosted project: bundles Worker code for a browser realm, for
 * `browserProjectRuntime({ code: { bundle } })`. Files are read through a FilesApi
 * (webrun-bundler). The bundle reads `cloudflare:workers`, `cloudflare:email` and the Workers
 * globals (`Response` with status 101, `WebSocketPair`) from what that runtime installs; with
 * nodejs_compat, `node:*` modules (and their bare names) are the realm's polyfills
 * (`globalThis.__cellsNodeModules`, which `browserProjectRuntime` sets).
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { FilesApi } from "@statewalker/webrun-files";
import { PROJECT_WORKERS_MODULE_SHIM } from "./browser-modules.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import {
  BARE_BUILTINS,
  bundleWorkerSource,
  EMAIL_MODULE_SHIM,
  globalModule,
  type WorkerSource,
} from "./worker-bundler.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

const requireFromPkg = createRequire(resolve(import.meta.dirname, "../../package.json"));

/**
 * A Node.js module with no browser polyfill, as an ES module: every export the module has on
 * this Node.js (the bundler runs on it) is a function that throws when called (a class to extend
 * too), and the default export answers any member the same way.
 */
function nodeStub(name: string): string {
  let names: string[] = [];
  try {
    names = Object.keys(requireFromPkg(name)).filter((n) => n !== "default");
  } catch {
    // not a module of this Node.js: the default export only
  }
  const what = JSON.stringify(name);
  return [
    `const fail = (key) => { throw new Error(${what} + "." + key + " is not available in browsers (nodejs_compat)"); };`,
    "const stub = (key) => function () { fail(key); };",
    ...names.map(
      (n, i) =>
        `const s${i} = stub(${JSON.stringify(n)}); export { s${i} as ${JSON.stringify(n)} };`,
    ),
    "export default new Proxy(Object.create(null), {",
    "  get(target, key) {",
    '    if (typeof key === "symbol" || key === "then" || key === "__esModule") return undefined;',
    "    if (!Object.hasOwn(target, key)) target[key] = stub(String(key));",
    "    return target[key];",
    "  },",
    "});",
  ].join("\n");
}

const GLOBALS_SHIM = `${WORKERS_GLOBAL_NAMES.map((n) => `export const ${n} = globalThis.__cellsGlobals.${n};`).join(" ")} export const scheduler = ${SCHEDULER_EXPRESSION};`;

/** nodejs_compat's globals for the bundle: the realm's `Buffer` and `process` polyfills. */
const NODE_GLOBALS_SHIM =
  "export const Buffer = globalThis.__cellsNodeModules.Buffer, process = globalThis.__cellsNodeModules.process;";

/** The realm's polyfills, by `node:*` name (their export names, read here on Node). */
let polyfills: Promise<Record<string, unknown>> | undefined;
const loadPolyfills = () =>
  (polyfills ??= import("../node-compat/browser-registry.js").then((m) => m.nodeRegistryEntries));

/** Bundles a Worker for `browserProjectRuntime`: an entry file on disk, or one of a FilesApi. */
export async function bundleWorkerForBrowser(
  entry: string | { files: FilesApi; root?: string; entry: string },
  opts: {
    nodeCompat?: boolean;
    /**
     * Lower `await` to generators (default: with `nodeCompat`), so that the node:async_hooks
     * polyfill carries AsyncLocalStorage stores through it. `false` only for browsers with TC39
     * AsyncContext, whose engine carries them through native awaits; a lowered bundle runs there
     * too.
     */
    lowerAwait?: boolean;
  } = {},
): Promise<string> {
  const source: WorkerSource = typeof entry === "string" ? { path: entry } : entry;
  const node = opts.nodeCompat ? await loadPolyfills() : {};
  const nodeModule = (spec: string): string | undefined => {
    if (!opts.nodeCompat) return undefined;
    const name = spec.startsWith("node:") ? spec : BARE_BUILTINS.has(spec) ? `node:${spec}` : "";
    if (!name) return undefined;
    const polyfill = node[name];
    if (polyfill === undefined) return nodeStub(name); // loads; fails when used, as wrangler's stubs
    const expr = `globalThis.__cellsNodeModules[${JSON.stringify(name)}]`;
    return globalModule(expr, Object.keys(polyfill as object));
  };
  const { code } = await bundleWorkerSource(source, {
    platform: "browser",
    conditions: ["browser"],
    // Function names are observable (the npm assert polyfill reports its caller's name as the
    // operator); bundling must not rename them.
    keepNames: true,
    // nodejs_compat: `await` lowered to generators, so that each one resumes through
    // Promise.prototype.then and carries its AsyncLocalStorage stores (node-compat/async_hooks.ts).
    lowerAwait: opts.lowerAwait ?? opts.nodeCompat,
    inject: ["cells:globals", ...(opts.nodeCompat ? ["cells:node-globals"] : [])],
    modules: (spec) => {
      if (spec === "cloudflare:workers") return PROJECT_WORKERS_MODULE_SHIM;
      if (spec === "cloudflare:email") return EMAIL_MODULE_SHIM;
      if (spec === "cells:globals") return GLOBALS_SHIM;
      if (spec === "cells:node-globals") return NODE_GLOBALS_SHIM;
      return nodeModule(spec);
    },
    name: typeof entry === "string" ? entry : entry.entry,
  });
  return code;
}
