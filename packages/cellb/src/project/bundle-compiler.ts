/**
 * `bundleCompiler`: a project's sources bundled in the browser by webrun-bundler on esbuild-wasm,
 * into one ES module that `browserProjectRuntime({ code: { bundle } })` runs as it runs a built
 * folder's `worker.js`. npm packages come from the project's `node_modules` (in its FilesApi) or
 * the npm registry, at the versions its `package.json` asks for.
 */
import {
  type BundleOptions,
  bundle,
  chainPackages,
  nodeModulesPackages,
  npmPackages,
  type PackageStore,
} from "@statewalker/webrun-bundler";
import { CELLS_GLOBALS_MODULE, cellbHostModule } from "./host-modules.js";
import type { ProjectCompiler } from "./source-project.js";

export interface BundleCompilerOptions {
  /** esbuild-wasm, initialized (`await esbuild.initialize({ wasmURL })`). */
  esbuild: BundleOptions["esbuild"];
  /**
   * Where bare specifiers go. Default: the project's own `node_modules`, then the npm registry.
   * Keep one store for several compiles (`npmPackages()`) and a second build fetches nothing.
   */
  packages?: PackageStore;
  /**
   * Lower `await` to generators, so that AsyncLocalStorage stores follow them (the
   * node:async_hooks polyfill rides on promise continuations). Default: with nodejs_compat, as
   * `cellb build` does; a lowered bundle runs on engines with AsyncContext too.
   */
  lowerAwait?: boolean;
  /** `package.json` `exports` conditions (default: workerd's, `["workerd", "worker", "browser"]`). */
  conditions?: string[];
}

/** One store per compiler: a second compile of the same project fetches nothing. */
function defaultPackages(): PackageStore {
  return chainPackages(nodeModulesPackages(), npmPackages());
}

/**
 * A compiler for `loadProject(files, { compile })` that bundles `main` and its packages into one
 * ES module. `cloudflare:workers`, `node:*` (nodejs_compat) and the Workers globals come from
 * the runtime (`cellbHostModule`), as in a folder `cellb build` writes.
 */
export function bundleCompiler(options: BundleCompilerOptions): ProjectCompiler {
  const packages = options.packages ?? defaultPackages();
  return {
    kind: "bundle",
    async compile({ files, config, nodeCompat }) {
      if (!config.main) return { code: { bundle: null } };
      // `node:*` only with nodejs_compat, which also takes a bare built-in name ("buffer") as one
      // when cellb has a polyfill for it. A `node:*` module without one is a stub that throws when
      // used, as `cellb build` and wrangler's nodejs_compat do (libraries import such modules in
      // code paths a Worker never takes).
      const modules = (spec: string) =>
        spec.startsWith("node:")
          ? nodeCompat
            ? (cellbHostModule(spec) ?? nodeStub(spec))
            : undefined
          : (cellbHostModule(spec) ??
            (nodeCompat && !spec.includes(":") ? cellbHostModule(`node:${spec}`) : undefined));
      const { code } = await bundle({
        esbuild: options.esbuild,
        files,
        entry: `/${config.main.replace(/^\.?\/+/, "")}`,
        packages,
        modules,
        inject: [CELLS_GLOBALS_MODULE], // Response, WebSocketPair… of the runtime, not the realm's
        conditions: options.conditions ?? ["workerd", "worker", "browser"],
        lowerAwait: options.lowerAwait ?? nodeCompat,
        sourcemap: false,
        // Function names are observable (the npm assert polyfill reports its caller's name as
        // the operator): bundling must not rename them, as in `cellb build`.
        esbuildOptions: { keepNames: true },
      });
      return { code: { bundle: code } };
    },
  };
}

/**
 * A Node.js module with no browser polyfill: CommonJS, so that every import links. Its default
 * export answers any member with a function that throws when called (or extended). A named import
 * is undefined (esbuild copies the members of a CommonJS module, and a stub cannot list them), so
 * it fails when used, not when loaded. `cellb build` lists the members from Node itself; a browser
 * cannot.
 */
function nodeStub(spec: string): string {
  const what = JSON.stringify(spec);
  return [
    `const fail = (key) => { throw new Error(${what} + "." + key + " is not available in browsers (nodejs_compat)"); };`,
    "module.exports = new Proxy(Object.create(null), {",
    "  get(target, key) {",
    '    if (typeof key === "symbol" || key === "then" || key === "__esModule") return undefined;',
    "    if (!(key in target)) target[key] = function () { fail(String(key)); };",
    "    return target[key];",
    "  },",
    "});",
  ].join("\n");
}
