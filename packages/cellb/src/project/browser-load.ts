/**
 * `loadProject` in a browser (`@statewalker/cellb/browser`), in a Dedicated Worker: fetches a
 * folder written by `cellb build` and runs it with `browserProjectRuntime`.
 */

import { type BrowserBucket, browserProjectRuntime } from "./browser-host.js";
import {
  BUILD_MANIFEST,
  filesApiReader,
  isFilesApi,
  type LoadedProject,
  type LoadProjectOptions,
  type ProjectSource,
  readBuildManifest,
  readBuiltProject,
  urlReader,
} from "./built-project.js";

export interface BrowserLoadProjectOptions extends LoadProjectOptions<BrowserBucket> {
  /**
   * Where loaded Workers (Worker Loader) run: the package's own isolate worker by default; a
   * script URL or a function starting a Dedicated Worker instead; `false` to run them in this
   * realm.
   */
  isolateScript?: URL | (() => Worker) | false;
}

/** The isolate worker this package ships (bundlers follow the `new Worker(new URL(…))` form). */
const ownIsolate = () =>
  new Worker(new URL("../isolate/isolate-worker.ts", import.meta.url), { type: "module" });

/**
 * Loads a built project and runs it in this worker.
 *
 * `source`: the URL of a `cellb build` folder (relative URLs resolve against the page or
 * worker), or a FilesApi holding one. `options.data` names the OPFS pool (`<data>`) and the
 * project's files directory (`<data>-files`); it defaults to the project's `name`.
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
  if (!manifest)
    throw new Error(
      `${where} has no ${BUILD_MANIFEST}: browsers load folders written by \`cellb build\``,
    );
  const built = await readBuiltProject(reader, manifest);
  const data = options.data ?? built.config.name ?? "cellb";
  const sqlite3 = options.sqlite3 ?? (await defaultSqlite3());
  const isolateScript =
    options.isolateScript === false ? undefined : (options.isolateScript ?? ownIsolate);
  const project = await browserProjectRuntime({
    config: built.config,
    code: { bundle: built.code },
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
    close: project.close,
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
