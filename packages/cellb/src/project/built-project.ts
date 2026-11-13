/**
 * The folder `cellb build` writes, and what `loadProject` reads, on both platforms:
 *
 *   wrangler.json   the project's configuration (`main` → "worker.js", `assets.directory` → "assets")
 *   worker.js       `main` bundled for a browser realm (bundleWorkerForBrowser), if there is a `main`
 *   assets/…        the files of `assets.directory`, as they are
 *   cellb.json      this manifest: the format, and the asset paths (a static host cannot list a folder)
 *
 * Platform-neutral: it reads through a `ProjectReader` (Node's fs, `fetch` of a URL, a FilesApi).
 */
import type { FilesApi } from "@statewalker/webrun-files";
import type { AssetFiles } from "../bindings/assets.js";
import type { WorkersAiOptions } from "../bindings/workers-ai.js";
import type { CellRuntime } from "../core/runtime.js";
import { parseJsonc } from "./jsonc.js";
import type { WranglerConfig } from "./wrangler.js";

/** The manifest's file name in a built folder. */
export const BUILD_MANIFEST = "cellb.json";
/** The format a built folder declares in its manifest. */
export const BUILD_FORMAT = "cellb-build/1";
/** The bundled `main` in a built folder. */
export const BUILT_WORKER = "worker.js";
/** The assets directory in a built folder. */
export const BUILT_ASSETS = "assets";

export interface BuildManifest {
  format: typeof BUILD_FORMAT;
  /** `worker.js`, or null for a project without `main` (assets only). */
  main: string | null;
  /** The asset files, as paths under `assets/` ("/index.html", "/css/site.css"). */
  assets: string[];
}

/** A built project in memory: what `browserProjectRuntime` takes. */
export interface BuiltProject {
  config: WranglerConfig;
  /** `main` bundled for a browser realm, or null. */
  code: string | null;
  assets: AssetFiles;
}

/** Reads the files of a project folder, wherever it lives; `undefined` for a missing file. */
export interface ProjectReader {
  bytes(path: string): Promise<Uint8Array | undefined>;
  /** The files under `dir`, as paths relative to it ("/a/b.html"); only where the source can list. */
  list?(dir: string): Promise<string[]>;
}

/** Where `loadProject` finds a project. */
export type ProjectSource =
  /** Node: a folder with wrangler.json(c), built or not; browser: the URL of a `cellb build` folder. */
  | string
  | URL
  /** Any FilesApi holding either kind of folder at its root. */
  | FilesApi;

/** Options of `loadProject`, the same on Node and in browsers. */
export interface LoadProjectOptions<Bucket = unknown> {
  /**
   * Where cells keep their data. Node: a directory (SQLite files and the project's files under
   * it; default: memory). Browser: an OPFS name, the pool (`<data>`) and the files directory
   * (`<data>-files`) (default: the project's `name`).
   */
  data?: string;
  /** A fleet bucket: a `BrowserBucket` in browsers, a `CellStorage` on Node. */
  bucket?: Bucket;
  /** The OpenAI-compatible endpoint behind the project's `ai` binding (Workers AI). */
  ai?: WorkersAiOptions;
  /** Browser only: an initialized SQLite WASM module (default: loads `@sqlite.org/sqlite-wasm`). */
  sqlite3?: unknown;
}

/** A running project. */
export interface LoadedProject {
  config: WranglerConfig;
  runtime: CellRuntime;
  /** Configuration entries cellb does not run (reported, not silently ignored). */
  unsupported: string[];
  /** A request to the project, as its Worker (and assets) answer it. */
  fetch(req: Request): Promise<Response>;
  /**
   * In a browser (an OPFS pool): the cells' databases as `[file name, bytes]`, named as
   * `nodeSqliteOpener(dir)` names them, so that a data directory on Node (`loadProject(dir,
   * { data })`) starts where this browser's cells are. Absent where cells are not in a pool.
   */
  exportCells?(): Promise<[string, Uint8Array][]>;
  close(): Promise<void>;
}

const decoder = new TextDecoder();

/** Reads JSON (or JSONC) at `path`, or undefined when the file is missing. */
export async function readJson<T>(reader: ProjectReader, path: string): Promise<T | undefined> {
  const bytes = await reader.bytes(path);
  return bytes ? (parseJsonc(decoder.decode(bytes)) as T) : undefined;
}

/** The manifest of a built folder, or undefined when the folder is not one. */
export async function readBuildManifest(reader: ProjectReader): Promise<BuildManifest | undefined> {
  const manifest = await readJson<BuildManifest>(reader, BUILD_MANIFEST);
  if (!manifest) return undefined;
  if (manifest.format !== BUILD_FORMAT)
    throw new Error(`${BUILD_MANIFEST}: unknown format ${JSON.stringify(manifest.format)}`);
  return manifest;
}

/** Reads a `cellb build` folder: its configuration, its bundled `main` and its assets. */
export async function readBuiltProject(
  reader: ProjectReader,
  manifest?: BuildManifest,
): Promise<BuiltProject> {
  manifest ??= await readBuildManifest(reader);
  if (!manifest) throw new Error(`no ${BUILD_MANIFEST}: not a folder written by \`cellb build\``);
  const config = await readJson<WranglerConfig>(reader, "wrangler.json");
  if (!config) throw new Error("no wrangler.json in the built folder");
  let code: string | null = null;
  if (manifest.main) {
    const bytes = await reader.bytes(manifest.main);
    if (!bytes) throw new Error(`${manifest.main} is missing from the built folder`);
    code = decoder.decode(bytes);
  }
  const assets: AssetFiles = new Map();
  await Promise.all(
    manifest.assets.map(async (p) => {
      const bytes = await reader.bytes(`${BUILT_ASSETS}${p}`);
      if (!bytes) throw new Error(`${BUILT_ASSETS}${p} is missing from the built folder`);
      assets.set(p, bytes);
    }),
  );
  return { config, code, assets };
}

/** A reader over a FilesApi, rooted at `root` ("/" by default). */
export function filesApiReader(files: FilesApi, root = "/"): ProjectReader {
  const base = root.endsWith("/") ? root : `${root}/`;
  const at = (p: string) => `${base}${p.replace(/^\/+/, "")}`;
  return {
    async bytes(path) {
      const full = at(path);
      const stats = await files.stats(full);
      if (!stats || stats.kind !== "file") return undefined;
      const chunks: Uint8Array[] = [];
      for await (const c of files.read(full)) chunks.push(c);
      return concat(chunks);
    },
    async list(dir) {
      const full = at(dir).replace(/\/+$/, "");
      const out: string[] = [];
      for await (const e of files.list(full, { recursive: true }))
        if (e.kind === "file") out.push(e.path.slice(full.length));
      return out;
    },
  };
}

/** A reader over HTTP: files of the folder at `base` (a URL ending in "/"). */
export function urlReader(base: URL, fetchFn: typeof fetch = fetch): ProjectReader {
  return {
    async bytes(path) {
      const res = await fetchFn(new URL(path.replace(/^\/+/, ""), base));
      if (res.status === 404) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.ok) throw new Error(`GET ${new URL(path, base)}: ${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Whether `v` is a FilesApi (a source given as files rather than a path or URL). */
export function isFilesApi(v: unknown): v is FilesApi {
  return (
    typeof v === "object" &&
    v !== null &&
    !(v instanceof URL) &&
    typeof (v as FilesApi).read === "function" &&
    typeof (v as FilesApi).list === "function" &&
    typeof (v as FilesApi).stats === "function"
  );
}

/** A built project's configuration as `wrangler.json` holds it: `main` and assets renamed. */
export function builtConfig(config: WranglerConfig): WranglerConfig {
  const out: WranglerConfig = { ...config };
  if (config.main) out.main = BUILT_WORKER;
  if (config.assets) out.assets = { ...config.assets, directory: BUILT_ASSETS };
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
