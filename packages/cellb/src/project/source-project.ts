/**
 * A project's sources (`wrangler.jsonc`, `main`, `package.json`, assets) in a FilesApi, and the
 * compilers that turn them into code `browserProjectRuntime` runs (`loadProject`'s `compile`).
 *
 * Platform-neutral and free of compilers: a compiler is made by the entry point that owns it
 * (`bundleCompiler` in `@statewalker/cellb/bundle`, `siteCompiler` in `@statewalker/cellb/site`),
 * so a plain `loadProject` ships neither esbuild-wasm nor webrun-modules.
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { AssetFiles } from "../bindings/assets.js";
import { filesApiReader, readJson } from "./built-project.js";
import type { WranglerConfig } from "./wrangler.js";

/** The configuration files a source folder may hold, in the order celld reads them. */
export const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json"];

/** A source project read from a FilesApi: what a compiler needs besides the files. */
export interface SourceProject {
  config: WranglerConfig;
  /** The files of `assets.directory` ("/index.html" → bytes), or undefined without assets. */
  assets?: AssetFiles;
}

/** What a compiler gives `browserProjectRuntime`: the project's code, and what to stop after. */
export interface CompiledProject {
  /** `browserProjectRuntime`'s `code`. */
  code: { bundle: string | null } | { site: string };
  /** Releases what the compiler holds (a site's ServiceWorker registration); after `close()`. */
  close?(): Promise<void>;
}

/** Turns a source project into code for `browserProjectRuntime` (`loadProject`'s `compile`). */
export interface ProjectCompiler {
  /** A name for messages ("bundle", "site"). */
  readonly kind: string;
  compile(project: {
    /** The project's files, its configuration at the root. */
    files: FilesApi;
    config: WranglerConfig;
    /** Whether the project has `nodejs_compat` (or a `nodejs_compat_*` flag). */
    nodeCompat: boolean;
  }): Promise<CompiledProject>;
}

/** Whether `config` asks for nodejs_compat. */
export function hasNodeCompat(config: WranglerConfig): boolean {
  return (config.compatibility_flags ?? []).some((f) => f.startsWith("nodejs_compat"));
}

/**
 * Reads a source folder at the root of `files`: its `wrangler.jsonc` (or `wrangler.json`) and the
 * files of its `assets.directory`. Undefined when there is no configuration.
 */
export async function readSourceProject(files: FilesApi): Promise<SourceProject | undefined> {
  const reader = filesApiReader(files);
  let config: WranglerConfig | undefined;
  for (const name of WRANGLER_FILES) {
    config = await readJson<WranglerConfig>(reader, name);
    if (config) break;
  }
  if (!config) return undefined;
  if (!config.main && !config.assets)
    throw new Error("wrangler config has neither `main` nor `assets`");
  if (!config.assets?.directory) return { config };
  const dir = `/${config.assets.directory.replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;
  const assets: AssetFiles = new Map();
  for (const path of await (reader.list as NonNullable<typeof reader.list>)(dir)) {
    const bytes = await reader.bytes(`${dir}${path}`);
    if (bytes) assets.set(path, bytes);
  }
  return { config, assets };
}
