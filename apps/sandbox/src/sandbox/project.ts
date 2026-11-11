// What a folder holds, and how its client part is served. Pure functions over a path → bytes
// map, shared by the page (the file tree, the summary) and the runner worker (the site).
//
// A project folder:
//   wrangler.jsonc         the server part: a Worker (Durable Objects, KV, D1…), run by CellB
//   <client>/index.html    the client part: an HTML app whose <script src> and <link href> name
//                          TS/TSX/JS/JSX/CSS files, compiled module by module in the browser
//   package.json           npm dependencies (a client/package.json, if any, wins for the client)
//
// The client folder is wrangler.jsonc's `client` field when it has one (an extension of the
// Wrangler file: `"client": "client"`), else `client/`, else `public/`, else the root when it has
// an index.html. The client calls the server with relative URLs (`fetch("api/tasks")`), so the
// same app runs under the sandbox's path and at the root of a real deployment.

import { parseJsonc } from "@statewalker/cellb-platform-core/util";

export type ProjectFiles = Map<string, Uint8Array>;

export interface WranglerLike {
  name?: string;
  main?: string;
  client?: string | { root?: string };
  [key: string]: unknown;
}

export interface ProjectLayout {
  /** The project's name: wrangler's `name`, else the folder's. */
  name: string;
  /** The Wrangler file's path, if any (the server part). */
  wranglerPath?: string;
  config?: WranglerLike;
  /** The client folder ("/client", or "/" for the root), if the project has a client part. */
  clientRoot?: string;
  /** True when the project has notebooks (`notebooks/*.md` or Notebook Kit `.html`). */
  notebooks: boolean;
  /** Problems worth showing (a Wrangler file that does not parse, no part to run). */
  problems: string[];
}

/** The prefix the client's compiled modules are served under, inside the app's site. */
export const MODULES_PREFIX = "/_modules/";

const WRANGLER_FILES = ["/wrangler.jsonc", "/wrangler.json"];
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/i;

export const decode = (b: Uint8Array) => new TextDecoder().decode(b);
export const encode = (s: string) => new TextEncoder().encode(s);

/** "/a/b/../c" → "/a/c"; always absolute, never ends with "/" (except the root). */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const join = (dir: string, path: string) => normalizePath(`${dir}/${path}`);

export function describeProject(files: ProjectFiles, folderName = "app"): ProjectLayout {
  const problems: string[] = [];
  const wranglerPath = WRANGLER_FILES.find((p) => files.has(p));
  let config: WranglerLike | undefined;
  if (wranglerPath) {
    try {
      config = parseJsonc(decode(files.get(wranglerPath) as Uint8Array)) as WranglerLike;
    } catch (err) {
      problems.push(`${wranglerPath.slice(1)} does not parse: ${(err as Error).message}`);
    }
    if (config && !config.main) problems.push(`${wranglerPath.slice(1)} has no "main"`);
    if (config?.main && !files.has(join("/", config.main)))
      problems.push(`"main" names ${config.main}, which is not in the folder`);
  }

  const declared = typeof config?.client === "string" ? config.client : config?.client?.root;
  const candidates = declared ? [join("/", declared)] : ["/client", "/public", "/"];
  const clientRoot = candidates.find((dir) => files.has(join(dir, "index.html")));
  if (declared && !clientRoot) problems.push(`"client" names ${declared}, which has no index.html`);
  const hasNotebooks = [...files.keys()].some((p) => /^\/notebooks\/.+\.(md|html)$/i.test(p));
  if (!wranglerPath && !clientRoot && !hasNotebooks)
    problems.push(
      "no wrangler.jsonc (server part), no index.html (client part) and no notebooks/ in the folder",
    );

  return {
    name: config?.name ?? folderName,
    wranglerPath,
    config,
    clientRoot,
    notebooks: hasNotebooks,
    problems,
  };
}

/** The client folder's files, rooted at "/", with the nearest package.json for npm versions. */
export function clientFilesOf(files: ProjectFiles, clientRoot: string): ProjectFiles {
  const out: ProjectFiles = new Map();
  const prefix = clientRoot === "/" ? "/" : `${clientRoot}/`;
  for (const [path, bytes] of files)
    if (clientRoot === "/" || path.startsWith(prefix))
      out.set(clientRoot === "/" ? path : path.slice(clientRoot.length), bytes);
  const pkg = files.get("/package.json");
  if (!out.has("/package.json") && pkg) out.set("/package.json", pkg);
  return out;
}

const isLocal = (url: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) && url.length > 0;

/**
 * An HTML page of the client, with each local `<script src>` naming a script file pointed at the
 * module server (`_modules/~/<path>`, compiled there) and marked `type="module"`. URLs stay
 * relative to the page, so the app runs under any base path. Stylesheets and other files are
 * served as they are.
 */
export function rewriteHtml(html: string, pagePath: string): string {
  const pageDir = dirOf(pagePath);
  const up = "../".repeat(pageDir.split("/").filter(Boolean).length) || "./";
  return html.replace(/<script\b([^>]*)>/gi, (tag, attrs: string) => {
    const m = /\ssrc\s*=\s*(["']?)([^"'\s>]+)\1/i.exec(attrs);
    if (!m) return tag;
    const src = m[2];
    const [path, query = ""] = src.split(/(?=[?#])/);
    if (!isLocal(src) || !SCRIPT_EXT.test(path)) return tag;
    const abs = path.startsWith("/") ? normalizePath(path) : join(pageDir, path);
    const url = `${up}${MODULES_PREFIX.slice(1)}~${abs}${query}`;
    let out = attrs.replace(m[0], ` src="${url}"`);
    if (/\stype\s*=/i.test(out))
      out = out.replace(/\stype\s*=\s*(["']?)[^"'\s>]*\1/i, ' type="module"');
    else out = ` type="module"${out}`;
    return `<script${out}>`;
  });
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  wasm: "application/wasm",
  woff2: "font/woff2",
  woff: "font/woff",
};

export const mimeOf = (path: string) =>
  MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** Folders a project never needs here (installed or generated). */
export const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".cellb",
  ".wrangler",
  ".astro",
  "dist",
  ".turbo",
  ".cache",
]);
