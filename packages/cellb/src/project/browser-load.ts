/**
 * `loadProject` in a browser (`@statewalker/cellb/browser`), in a Dedicated Worker: fetches a
 * folder written by `cellb build`, or compiles a source folder with the `compile` it is given,
 * and runs it with `browserProjectRuntime`.
 */

import { type BrowserBucket, browserProjectRuntime } from "./browser-host.js";
import {
  BUILD_MANIFEST,
  type BuiltProject,
  filesApiReader,
  isFilesApi,
  type LoadedProject,
  type LoadProjectOptions,
  type ProjectSource,
  readBuildManifest,
  readBuiltProject,
  urlReader,
} from "./built-project.js";
import {
  type CompiledProject,
  hasNodeCompat,
  type ProjectCompiler,
  readSourceProject,
  WRANGLER_FILES,
} from "./source-project.js";

export interface BrowserLoadProjectOptions extends LoadProjectOptions<BrowserBucket> {
  /**
   * Where loaded Workers (Worker Loader) run: the package's own isolate worker by default; a
   * script URL or a function starting a Dedicated Worker instead; `false` to run them in this
   * realm.
   */
  isolateScript?: URL | (() => Worker) | false;
  /**
   * How a source folder (`wrangler.jsonc`, `main`, `package.json`, assets) becomes code, for a
   * FilesApi that holds one: `bundleCompiler` (`@statewalker/cellb/bundle`: webrun-bundler and
   * esbuild-wasm, one ES module) or `siteCompiler` (`@statewalker/cellb/site`: modules compiled
   * one by one and served from a ServiceWorker). Without it, only `cellb build` folders load.
   * A folder written by `cellb build` loads as built either way.
   */
  compile?: ProjectCompiler;
}

/** The isolate worker this package ships (bundlers follow the `new Worker(new URL(…))` form). */
const ownIsolate = () =>
  new Worker(new URL("../isolate/isolate-worker.ts", import.meta.url), { type: "module" });

/**
 * Loads a project and runs it in this worker.
 *
 * `source`: the URL of a `cellb build` folder (relative URLs resolve against the page or
 * worker), or a FilesApi holding one — or, with `options.compile`, a FilesApi holding the
 * project's sources (`wrangler.jsonc` and `main` at its root, `package.json`, assets).
 * `options.data` names the OPFS pool (`<data>`) and the project's files directory
 * (`<data>-files`); it defaults to the project's `name`.
 */
export async function loadProject(
  source: ProjectSource,
  options: BrowserLoadProjectOptions = {},
): Promise<LoadedProject> {
  let reader: ReturnType<typeof urlReader>;
  let where: string;
  if (isFilesApi(source)) {
    reader = filesApiReader(source);
    where = "the FilesApi";
  } else {
    const url = new URL(String(source), (globalThis as { location?: Location }).location?.href);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    reader = urlReader(url);
    where = url.href;
  }
  const manifest = await readBuildManifest(reader);
  let built: BuiltProject;
  let compiled: CompiledProject | undefined;
  if (manifest) built = await readBuiltProject(reader, manifest);
  else if (isFilesApi(source) && options.compile) {
    const project = await readSourceProject(source);
    if (!project)
      throw new Error(
        `the FilesApi has neither ${BUILD_MANIFEST} nor ${WRANGLER_FILES.join(" nor ")}`,
      );
    const { config } = project;
    compiled = config.main
      ? await options.compile.compile({ files: source, config, nodeCompat: hasNodeCompat(config) })
      : { code: { bundle: null } };
    built = { config, code: null, assets: project.assets ?? new Map() };
  } else
    throw new Error(
      isFilesApi(source)
        ? `${where} has no ${BUILD_MANIFEST}: pass \`compile\` to load a source folder, or load a folder written by \`cellb build\``
        : `${where} has no ${BUILD_MANIFEST}: browsers load folders written by \`cellb build\` by URL (a source folder loads from a FilesApi, with \`compile\`)`,
    );
  try {
    const close = compiled?.close?.bind(compiled);
    const release = close && (() => close());
    return await run(built, compiled?.code ?? { bundle: built.code }, options, release);
  } catch (err) {
    await compiled?.close?.().catch(() => {});
    throw err;
  }
}

async function run(
  built: BuiltProject,
  code: CompiledProject["code"],
  options: BrowserLoadProjectOptions,
  release?: () => Promise<void>,
): Promise<LoadedProject> {
  const data = options.data ?? built.config.name ?? "cellb";
  const sqlite3 = options.sqlite3 ?? (await defaultSqlite3());
  const isolateScript =
    options.isolateScript === false ? undefined : (options.isolateScript ?? ownIsolate);
  const project = await browserProjectRuntime({
    config: built.config,
    code,
    assetFiles: built.assets,
    sqlite3,
    pool: data,
    filesDir: `${data}-files`,
    bucket: options.bucket,
    ai: options.ai,
    isolateScript,
  });
  const { runtime } = project;
  return {
    config: built.config,
    runtime,
    unsupported: project.unsupported,
    fetch: (req) => runtime.fetch(req),
    exportCells: () => project.exportCells(),
    close: async () => {
      try {
        await project.close();
      } finally {
        await release?.();
      }
    },
  };
}

let sqlite3Module: Promise<unknown> | undefined;
/** `@sqlite.org/sqlite-wasm`, initialized once per worker. */
function defaultSqlite3(): Promise<unknown> {
  sqlite3Module ??= import("@sqlite.org/sqlite-wasm").then(({ default: init }) =>
    (init as (o: object) => Promise<unknown>)({ print() {}, printErr() {} }),
  );
  return sqlite3Module;
}
