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
import { GLOBALS_SHIM } from "./workers-global-names.js";

const pkg = resolve(import.meta.dirname, "../..");
const requireFromPkg = createRequire(resolve(pkg, "package.json"));

/**
 * A Node.js module with no browser polyfill, as CommonJS so that any named import binds: each
 * export is a function (a class too) that throws when called, the module's default is the same.
 */
const nodeStub = (name: string) => `
const fail = (what) => { throw new Error(${JSON.stringify(name)} + (what ? "." + what : "") + " is not available in browsers (nodejs_compat)"); };
const exports_ = {};
module.exports = new Proxy(exports_, {
  get(target, key) {
    if (typeof key === "symbol" || key === "__esModule" || key === "then") return undefined;
    if (!(key in target)) target[key] = function () { fail(String(key)); };
    return target[key];
  },
});
`;

/** A bare Node.js built-in name ("path", "fs/promises"): nodejs_compat takes it as `node:…`. */
const bareBuiltin = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.includes(":")));

/** Bundles the Worker module at `entry` into one ES module for `browserProjectRuntime`. */
export async function bundleWorkerForBrowser(
  entry: string,
  opts: { nodeCompat?: boolean } = {},
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
    ...(opts.nodeCompat
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
