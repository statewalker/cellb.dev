/**
 * Data loaders, as Observable Framework names them: a source file `data/sales.csv.js` (or `.ts`,
 * `.mjs`) is the loader of `data/sales.csv`. Its default export is the data, or a function that
 * returns it (async allowed): a string, bytes, a Blob, a Response, or a value written as JSON.
 *
 * In the browser and in Workers there is no process to run and no stdout to read, so a loader is a
 * module, not a script: the build bundles it as a small Worker (`loaderProject`, built by the
 * platform's bundler, its npm imports from the package store) and runs that Worker once in a
 * Worker Loader isolate, whose `fetch` answers with the data. A loader may use `fetch` (an API, a
 * remote file); its output is kept until its build changes.
 */

import type { FilesApi } from "@statewalker/webrun-files";

/**
 * The sources as a notebook build reads them: a data loader's output is there, at the path it
 * produces, as an attachment is (the build checks that each `FileAttachment` exists).
 * Everything but reading goes to `sources`.
 */
export function withLoaderOutputs(sources: FilesApi, outputs: FilesApi): FilesApi {
  const from = async (path: string) => ((await outputs.exists(path)) ? outputs : sources);
  return {
    async *read(path, options) {
      yield* (await from(path)).read(path, options);
    },
    write: (path, content) => sources.write(path, content),
    mkdir: (path) => sources.mkdir(path),
    list: (path, options) => sources.list(path, options),
    stats: async (path) => (await from(path)).stats(path),
    exists: async (path) => (await outputs.exists(path)) || sources.exists(path),
    remove: (path) => sources.remove(path),
    move: (a, b) => sources.move(a, b),
    copy: (a, b) => sources.copy(a, b),
  };
}

/** The output extensions a loader may produce: data, not code, not notebooks. */
const DATA_EXTENSIONS = new Set([
  "arrow",
  "bin",
  "csv",
  "db",
  "geojson",
  "gif",
  "jpeg",
  "jpg",
  "json",
  "ndjson",
  "parquet",
  "png",
  "sqlite",
  "svg",
  "topojson",
  "tsv",
  "txt",
  "webp",
  "xlsx",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

const LOADER = /^(.+\.([A-Za-z0-9]+))\.(js|mjs|ts)$/;

/** The file a loader produces (`/data/sales.csv` for `/data/sales.csv.js`), if `path` is one. */
export function loaderTarget(path: string): string | undefined {
  const m = LOADER.exec(path);
  const ext = (m?.[2] ?? "").toLowerCase();
  // `.sql`: a database's script (`warehouse.sql.js` → `warehouse.sql`), never served.
  return m?.[1] && (DATA_EXTENSIONS.has(ext) || ext === "sql") ? m[1] : undefined;
}

/** What a site serves of its sources besides loader outputs: data, media, documents, fonts. */
const SERVED_EXTENSIONS = new Set([
  ...DATA_EXTENSIONS,
  "avif",
  "ico",
  "mp3",
  "mp4",
  "ogg",
  "otf",
  "pdf",
  "ttf",
  "wav",
  "webm",
  "woff",
  "woff2",
]);

/**
 * Whether `path` may be served as a data file: every segment a plain name (no empty, `.`, `..`
 * or dot-file segment, so `/x.json.js/.` or `/.env` never reach the store, which would normalize
 * them), and a data, media or font extension (so no code, no notebook source, no secrets file).
 */
export function isDataPath(path: string): boolean {
  const segments = path.split("/").slice(1);
  if (!path.startsWith("/") || segments.some((s) => s === "" || s.startsWith("."))) return false;
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext !== undefined && SERVED_EXTENSIONS.has(ext);
}

/**
 * What `runLoaders` runs a loader for: a data path, or a database's script (`warehouse.sql`,
 * from `warehouse.sql.js`), which is stored with the data but never served.
 */
export function isLoaderOutput(path: string): boolean {
  if (isDataPath(path)) return true;
  const segments = path.split("/").slice(1);
  if (!path.startsWith("/") || segments.some((s) => s === "" || s.startsWith("."))) return false;
  return /\.sql$/i.test(path);
}

/** A source file served as it is: a data path that is not a loader (loaders produce data). */
export const isServedSource = (path: string) => isDataPath(path) && !loaderTarget(path);

/** Whether a source file is a notebook (a page), not data. */
export const isNotebook = (path: string) => /\.(md|html)$/.test(path);

/**
 * The Worker project of a loader, as the bundler takes it (`POST /builds`, JSON `{ files }`): the
 * loader as `loader.<ext>`, and an entry whose `fetch` answers with its data.
 */
export function loaderProject(path: string, source: string): Record<string, string> {
  const ext = /\.(mjs|ts)$/.exec(path)?.[1] ?? "js";
  return {
    "wrangler.json": JSON.stringify({
      name: "notebook-data-loader",
      main: "main.js",
      compatibility_date: "2026-02-24",
      compatibility_flags: ["nodejs_compat"],
    }),
    [`loader.${ext}`]: source,
    "main.js": `import * as loader from "./loader.${ext}";

const bytes = (v) =>
  typeof v === "string" || v instanceof ArrayBuffer || ArrayBuffer.isView(v) ||
  v instanceof Blob || v instanceof ReadableStream;

export default {
  async fetch() {
    try {
      const d = loader.default;
      const v = await (typeof d === "function" ? d() : d);
      if (v instanceof Response) return v;
      if (v === undefined) throw new Error("the loader's default export gave no data");
      return new Response(bytes(v) ? v : JSON.stringify(v));
    } catch (e) {
      return new Response(String(e?.stack ?? e), { status: 500, headers: { "x-loader-error": "1" } });
    }
  },
};
`,
  };
}

const TYPES: Record<string, string> = {
  arrow: "application/vnd.apache.arrow.file",
  csv: "text/csv; charset=utf-8",
  geojson: "application/geo+json",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  ndjson: "application/x-ndjson",
  parquet: "application/vnd.apache.parquet",
  png: "image/png",
  svg: "image/svg+xml",
  topojson: "application/json",
  tsv: "text/tab-separated-values; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  zip: "application/zip",
};

export const contentType = (path: string) =>
  TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
