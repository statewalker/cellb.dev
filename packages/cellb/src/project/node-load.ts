/**
 * `loadProject` on Node (`@statewalker/cellb/node`): one call that reads a project, built or
 * not, and runs it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import type { WorkerModule } from "../core/runtime.js";
import type { CellStorage } from "../ports.js";
import {
  BUILD_MANIFEST,
  BUILT_WORKER,
  type BuiltProject,
  filesApiReader,
  isFilesApi,
  type LoadedProject,
  type LoadProjectOptions,
  type ProjectReader,
  type ProjectSource,
  readBuildManifest,
  readBuiltProject,
  urlReader,
} from "./built-project.js";
import * as workersClasses from "./cloudflare-workers.js";
import { loadNodeProject, nodeIsolatedLoader, nodeModuleLoader } from "./node-project.js";
import { workerScope } from "./worker-scope.js";
import * as workersGlobals from "./workers-globals-module.js";
import {
  createProjectRuntime,
  loadProjectBindings,
  loadTimeEnv,
  type ProjectHost,
  populatesProcessEnv,
  processEnvOf,
} from "./wrangler.js";

export type NodeLoadProjectOptions = LoadProjectOptions<CellStorage>;

/**
 * Loads a project and runs it in this process.
 *
 * `source`: a folder with `wrangler.json(c)` (its `main` bundled with esbuild, as
 * `loadNodeProject` does), a folder written by `cellb build` (its `worker.js` imported as built),
 * an `http(s):` URL of a built folder, or a FilesApi holding either kind of folder.
 *
 * `options.data`: a directory for the cells' SQLite files and the project's files
 * (`<data>/files`); without it, both are in memory.
 */
export async function loadProject(
  source: ProjectSource,
  options: NodeLoadProjectOptions = {},
): Promise<LoadedProject> {
  const host = nodeHost(options);
  const close = async (runtime: { close(): Promise<void> }, cleanup?: () => void) => {
    await runtime.close();
    cleanup?.();
  };
  // A folder on disk: read where it lies.
  const dir = localDir(source);
  if (dir !== undefined) {
    const reader = fsReader(dir);
    const manifest = await readBuildManifest(reader);
    if (manifest) return runBuilt(await readBuiltProject(reader, manifest), host);
    const { runtime, unsupported, config } = await loadNodeProject(dir, host);
    return {
      config,
      runtime,
      unsupported,
      fetch: (req) => runtime.fetch(req),
      close: () => close(runtime),
    };
  }
  // A FilesApi: a built folder is read from it; a source folder is copied out for esbuild.
  if (isFilesApi(source)) {
    const reader = filesApiReader(source);
    const manifest = await readBuildManifest(reader);
    if (manifest) return runBuilt(await readBuiltProject(reader, manifest), host);
    const tmp = await copyOut(source);
    try {
      const { runtime, unsupported, config } = await loadNodeProject(tmp, host);
      return {
        config,
        runtime,
        unsupported,
        fetch: (req) => runtime.fetch(req),
        close: () => close(runtime, () => rmSync(tmp, { recursive: true, force: true })),
      };
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }
  // A URL of a built folder.
  const url = folderUrl(source);
  const reader = urlReader(url);
  const manifest = await readBuildManifest(reader);
  if (!manifest)
    throw new Error(`${url} has no ${BUILD_MANIFEST}: load a folder written by \`cellb build\``);
  return runBuilt(await readBuiltProject(reader, manifest), host);
}

/** What `options` become on Node: SQLite files and a FilesApi under `data`, or memory. */
function nodeHost(options: NodeLoadProjectOptions): Omit<ProjectHost, "loadModules"> {
  let files: FilesApi;
  if (options.data) {
    const data = resolve(options.data);
    mkdirSync(join(data, "files"), { recursive: true });
    files = new NodeFilesApi({ rootDir: join(data, "files") });
  } else files = new MemFilesApi();
  return {
    // On a bucket every commit is logged as LTX: page capture reads its pages from the WAL
    // (O(changed pages)) instead of imaging and diffing the whole database per commit.
    openSql: nodeSqliteOpener(options.data ? resolve(options.data) : undefined, {
      pageCapture: !!options.bucket,
    }),
    files,
    storage: options.bucket,
    ai: options.ai,
  };
}

/**
 * Runs a built project on Node: `worker.js` was bundled for a browser realm, so it reads the
 * Workers globals and `cloudflare:workers` from the globals this sets, as in a browser worker.
 * (One such project per process: the globals are the process's.)
 */
async function runBuilt(
  built: BuiltProject,
  host: Omit<ProjectHost, "loadModules">,
): Promise<LoadedProject> {
  const { config } = built;
  const flags = config.compatibility_flags ?? [];
  const scope = workerScope(loadTimeEnv(config, host.ai));
  const g = globalThis as Record<string, unknown>;
  g.__cellsWorkersModule = workersClasses;
  g.__cellsProjectScope = scope;
  g.__cellsGlobals = {
    ...workersGlobals,
    Request: workersGlobals.CellsRequest,
    Response: workersGlobals.CellsResponse,
    WebSocketPair: flags.includes("websocket_standard_binary_type")
      ? workersGlobals.StandardWebSocketPair
      : workersGlobals.WebSocketPair,
  };
  if (populatesProcessEnv(config)) {
    const env = processEnvOf(config);
    g.__cellsProcessEnv = env;
    for (const [k, v] of Object.entries(env)) process.env[k] ??= v;
  }
  let module: WorkerModule = { default: {} } as WorkerModule;
  if (built.code !== null) {
    const tmp = mkdtempSync(join(tmpdir(), "cellb-built-"));
    const file = join(tmp, BUILT_WORKER.replace(/\.js$/, ".mjs"));
    writeFileSync(file, built.code);
    try {
      module = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as WorkerModule;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const project = createProjectRuntime(config, module, {
    bindings: await loadProjectBindings(config),
    loadModules: nodeModuleLoader,
    isolatedModules: nodeIsolatedLoader(() => host.storage),
    assetFiles: built.assets,
    ...host,
  });
  scope.bind(project.runtime);
  const { runtime, unsupported } = project;
  return {
    config,
    runtime,
    unsupported,
    fetch: (req) => runtime.fetch(req),
    close: () => runtime.close(),
  };
}

/** The folder a source names on this machine: a path or a `file:` URL. */
function localDir(source: ProjectSource): string | undefined {
  if (typeof source === "string") {
    if (/^https?:\/\//i.test(source)) return undefined;
    return resolve(source.startsWith("file:") ? fileURLToPath(source) : source);
  }
  if (source instanceof URL && source.protocol === "file:") return fileURLToPath(source);
  return undefined;
}

function folderUrl(source: ProjectSource): URL {
  const url = new URL(String(source));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function fsReader(dir: string): ProjectReader {
  return {
    async bytes(path) {
      const full = join(dir, path);
      return existsSync(full) ? new Uint8Array(readFileSync(full)) : undefined;
    },
  };
}

/** Copies a FilesApi's files into a temporary folder (esbuild bundles from disk). */
async function copyOut(files: FilesApi): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "cellb-project-"));
  const reader = filesApiReader(files);
  for (const path of (await reader.list?.("/")) ?? []) {
    const out = join(tmp, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, (await reader.bytes(path)) as Uint8Array);
  }
  return tmp;
}
