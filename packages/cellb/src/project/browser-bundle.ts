/**
 * Node side of a browser-hosted project: bundles Worker code for a browser realm, for
 * `browserProjectRuntime({ code: { bundle } })`. The bundle reads `cloudflare:workers` and the
 * Workers globals (`Response` with status 101, `WebSocketPair`) from what that runtime installs;
 * with nodejs_compat, `node:*` modules (and their bare names) become browser polyfills.
 */
import { builtinModules, createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { NODE_POLYFILL_FILES, NODE_POLYFILL_PACKAGES } from "../node-compat/modules.js";
import { PROJECT_WORKERS_MODULE_SHIM } from "./browser-modules.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

const pkg = resolve(import.meta.dirname, "../..");
const requireFromPkg = createRequire(resolve(pkg, "package.json"));

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

/** A bare Node.js built-in name ("path", "fs/promises"): nodejs_compat takes it as `node:…`. */
const bareBuiltin = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.includes(":")));

/** Bundles the Worker module at `entry` into one ES module for `browserProjectRuntime`. */
export async function bundleWorkerForBrowser(
  entry: string,
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
  const out = await build({
    entryPoints: [entry],
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    // Function names are observable (the npm assert polyfill reports its caller's name as the
    // operator); bundling must not rename them.
    keepNames: true,
    // nodejs_compat: `await` lowered to generators, so that each one resumes through
    // Promise.prototype.then and carries its AsyncLocalStorage stores (node-compat/async_hooks.ts).
    ...((opts.lowerAwait ?? opts.nodeCompat)
      ? { supported: { "async-await": false, "async-generator": false, "for-await": false } }
      : {}),
    logLevel: "silent",
    inject: [
      "cells:globals",
      ...(opts.nodeCompat ? [resolve(pkg, "src/node-compat/globals.ts")] : []),
    ],
    plugins: [
      {
        name: "cells-browser",
        setup(b) {
          // nodejs_compat: node:* → browser polyfills, bundled in.
          if (opts.nodeCompat)
            b.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (a) => {
              const name = a.path.startsWith("node:") ? a.path : `node:${a.path}`;
              if (!a.path.startsWith("node:") && !bareBuiltin.has(a.path)) return undefined;
              const file = NODE_POLYFILL_FILES[name];
              if (file) return { path: resolve(pkg, "src/node-compat", file) };
              const polyfill = NODE_POLYFILL_PACKAGES[name];
              // "buffer/" (trailing slash): the npm package, not the Node.js built-in of that name
              if (polyfill) return { path: requireFromPkg.resolve(`${polyfill}/`) };
              // No browser polyfill: a stub that loads and throws when used, as wrangler's
              // nodejs_compat stubs do on Cloudflare (libraries import such modules in code
              // paths a Worker never takes, e.g. a CLI's login).
              return { path: name, namespace: "cells-node-stub" };
            });
          b.onLoad({ filter: /.*/, namespace: "cells-node-stub" }, (a) => ({
            contents: nodeStub(a.path),
            loader: "js",
          }));
          b.onResolve({ filter: /^cloudflare:email$/ }, () => ({
            path: resolve(pkg, "src/project/cloudflare-email.ts"),
          }));
          b.onResolve({ filter: /^cloudflare:workers$|^cells:globals$/ }, (a) => ({
            path: a.path,
            namespace: "cells",
          }));
          b.onLoad({ filter: /.*/, namespace: "cells" }, (a) => ({
            contents: a.path === "cloudflare:workers" ? PROJECT_WORKERS_MODULE_SHIM : GLOBALS_SHIM,
            loader: "js",
          }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}
