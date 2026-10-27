/**
 * Worker code → one ES module, with @statewalker/webrun-bundler: every file of the project
 * and of its packages is read through a FilesApi (a project on disk through
 * `NodeFilesApi`, Worker Loader modules from a `MemFilesApi`); the runtime's own modules
 * (`cloudflare:workers`, the Workers globals, `node:*` in browsers) are modules the host
 * supplies, which read the runtime from `globalThis`. The bundle carries its source map, so
 * an error's stack traces to the Worker's own files and its packages' sources.
 */
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { bundle, nodeModulesPackages } from "@statewalker/webrun-bundler";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import * as esbuild from "esbuild";

/** Worker code to bundle: a file on disk, Worker Loader modules, or a file of a FilesApi. */
export type WorkerSource =
  | { path: string }
  | { modules: Record<string, string>; main: string }
  | { files: FilesApi; root?: string; entry: string };

/** A bare Node.js built-in name ("path", "fs/promises"), which nodejs_compat takes as `node:…`. */
export const BARE_BUILTINS = new Set(
  builtinModules.filter((m) => !m.startsWith("_") && !m.includes(":")),
);

const enc = new TextEncoder();
const JS = /\.(m|c)?[jt]sx?$/;

/** The FilesApi, root and entry a source is bundled from. */
async function sourceFiles(src: WorkerSource) {
  if ("files" in src) return { files: src.files, root: src.root ?? "/", entry: src.entry };
  if ("path" in src) {
    // The entry's top-level directory as the project (`/home`, `/tmp`): packages resolve from
    // the folders above the entry, as Node finds them. (Not `/` itself: NodeFilesApi refuses
    // every path under a rootDir of `/`.)
    const path = resolve(src.path);
    const top = `/${path.split("/")[1]}`;
    return {
      files: new NodeFilesApi({ rootDir: top }),
      root: "/",
      entry: path.slice(top.length),
    };
  }
  const files = new MemFilesApi();
  for (const [name, text] of Object.entries(src.modules)) {
    // A module's text is JavaScript whatever its name (text, json and wasm modules arrive
    // wrapped as ES modules); `import "./data.json"` finds `data.json.js`.
    const path = `/${name}${JS.test(name) ? "" : ".js"}`;
    await files.write(path, [enc.encode(text)]);
  }
  return { files, root: "/", entry: `/${src.main}` };
}

export interface WorkerBundleOptions {
  /** Modules the host supplies, by specifier (see webrun-bundler's `modules`). */
  modules: (specifier: string) => string | undefined;
  inject?: string[];
  external?: string[];
  platform: "browser" | "neutral";
  conditions?: string[];
  lowerAwait?: boolean;
  /** Function and class names stay as written (they are observable). */
  keepNames?: boolean;
  /** Names the module in stack traces: `cellb-worker:/<name>`. */
  name: string;
}

/** Bundles a Worker; the code carries its map inline and names itself for stack traces. */
export async function bundleWorkerSource(src: WorkerSource, opts: WorkerBundleOptions) {
  const { files, root, entry } = await sourceFiles(src);
  const r = await bundle({
    esbuild,
    files,
    root,
    entry,
    packages: nodeModulesPackages(),
    modules: opts.modules,
    inject: opts.inject,
    external: opts.external,
    conditions: opts.conditions ?? ["workerd", "worker", "browser"],
    platform: opts.platform,
    format: "esm",
    target: "es2022",
    lowerAwait: opts.lowerAwait,
    sourcemap: "inline",
    esbuildOptions: opts.keepNames ? { keepNames: true } : undefined,
  });
  return {
    code: `${r.code}//# sourceURL=cellb-worker:/${opts.name.replace(/^\/+/, "")}\n`,
    map: r.map,
  };
}

/** A module of the host as an ES module: `default` is the value, named exports its keys. */
export function globalModule(expression: string, names: Iterable<string>): string {
  const ids = [...new Set(names)].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
  // No local names: esbuild would rename the Worker's variables of the same names.
  return [
    `export default ${expression};`,
    ...(ids.length
      ? [`export const ${ids.map((n) => `${n} = ${expression}.${n}`).join(", ")};`]
      : []),
  ].join("\n");
}

/** `cloudflare:email`, read from `globalThis.__cellsEmailModule`. */
export const EMAIL_MODULE_SHIM = globalModule("globalThis.__cellsEmailModule", ["EmailMessage"]);
