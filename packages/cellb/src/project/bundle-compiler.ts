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
      // `node:*` only with nodejs_compat, which also takes a bare built-in name ("buffer") as one.
      const modules = (spec: string) =>
        spec.startsWith("node:")
          ? nodeCompat
            ? cellbHostModule(spec)
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
      });
      return { code: { bundle: code } };
    },
  };
}
