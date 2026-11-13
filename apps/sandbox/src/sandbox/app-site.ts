// The running app as one site (a `Request → Response` handler), hosted by the page's
// ServiceWorker under its own path:
//
//   GET /_modules/~/<path>   a client script, compiled to browser ESM by webrun-modules (TS, TSX,
//                            JSX, CSS imports); npm imports downloaded from the registry at the
//                            versions package.json asks for, and served from here too
//   GET /<path>              a client file (HTML pages get their <script src> rewritten)
//   anything else            the server part: the Worker CellB runs (`fetch`)

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer } from "@statewalker/webrun-modules";
import {
  decode,
  encode,
  MODULES_PREFIX,
  mimeOf,
  normalizePath,
  type ProjectFiles,
  rewriteHtml,
} from "./project";

export interface AppServer {
  fetch(request: Request): Promise<Response>;
}

export interface AppSiteOptions {
  /** The client folder's files, rooted at "/" (`clientFilesOf`), if the app has a client. */
  client?: ProjectFiles;
  /** The server part, if the app has one. */
  server?: AppServer;
  /** Where errors go (a module that does not compile, a server that throws). */
  log?: (text: string, level?: "info" | "error") => void;
  /** The module server's cache: one per runner, so a rebuild downloads no package twice. */
  moduleCache?: MemFilesApi;
  /** The notebooks' handler (notebooks.ts), for requests below `notebooks/`. */
  notebooks?: (request: Request, path: string) => Promise<Response>;
}

/** Where webrun-modules keeps the project's own compiled files in its cache (target "browser"). */
const PROJECT_CACHE = "/t/browser/~";

export type AppSite = (request: Request) => Promise<Response>;

export async function createAppSite(opts: AppSiteOptions): Promise<AppSite> {
  const log = opts.log ?? (() => {});
  const client = opts.client;
  let modules: ReturnType<typeof newModuleServer> | undefined;
  if (client) {
    const project = new MemFilesApi();
    for (const [path, bytes] of client) await project.write(path, [bytes]);
    const cache = opts.moduleCache ?? new MemFilesApi();
    // A shared cache keeps the npm packages (/raw, /t/<target>/<pkg>@<version>) but not the
    // project's compiled files (/t/<target>/~), which belong to the previous run's sources.
    await cache.remove(PROJECT_CACHE).catch(() => {});
    modules = newModuleServer({
      cache,
      project,
      basePath: MODULES_PREFIX,
      target: "browser",
    });
  }

  const notFound = (path: string) =>
    new Response(`Not found: ${path}`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  function clientFile(path: string): Response | undefined {
    if (!client) return undefined;
    let p = normalizePath(decodeURIComponent(path));
    if (path.endsWith("/")) p = `${p === "/" ? "" : p}/index.html`;
    let bytes = client.get(p);
    // "/about" → "/about.html" or "/about/index.html", as static hosts do.
    if (!bytes && !/\.[a-z0-9]+$/i.test(p)) {
      for (const alt of [`${p}.html`, `${p}/index.html`]) {
        bytes = client.get(alt);
        if (bytes) {
          p = alt;
          break;
        }
      }
    }
    if (!bytes || p === "/package.json") return undefined;
    const type = mimeOf(p);
    const body = type.startsWith("text/html") ? encode(rewriteHtml(decode(bytes), p)) : bytes;
    return new Response(body as BodyInit, {
      headers: { "content-type": type, "cache-control": "no-store" },
    });
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (opts.notebooks && (path === "/notebooks" || path.startsWith("/notebooks/"))) {
        if (path === "/notebooks")
          return new Response(null, { status: 302, headers: { location: "notebooks/" } });
        const res = await opts.notebooks(request, path.slice("/notebooks".length));
        if (res.status >= 400) log(`notebooks: ${path} → ${res.status}`, "error");
        return res;
      }
      if (modules && path.startsWith(MODULES_PREFIX)) {
        const res = await modules.fetch(request);
        if (res.status >= 400) {
          const text = await res.clone().text();
          log(`client: ${path.slice(MODULES_PREFIX.length + 1)} → ${res.status} ${text}`, "error");
        }
        // The project's own modules change from run to run: never from the HTTP cache.
        if (!path.startsWith(`${MODULES_PREFIX}~/`)) return res;
        const headers = new Headers(res.headers);
        headers.set("cache-control", "no-store");
        return new Response(res.body, { status: res.status, headers });
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const file = clientFile(path);
        if (file) return file;
      }
      if (!opts.server) return notFound(path);
      // The server sees the app's own URL space: the path below the site, the query, the body.
      const init: RequestInit = { method: request.method, headers: request.headers };
      if (request.method !== "GET" && request.method !== "HEAD")
        init.body = await request.arrayBuffer();
      const res = await opts.server.fetch(
        new Request(`http://localhost${path}${url.search}`, init),
      );
      if (res.status >= 500) log(`server: ${request.method} ${path} → ${res.status}`, "error");
      return res;
    } catch (err) {
      const message = String((err as Error)?.stack ?? err);
      log(`${request.method} ${path} failed: ${message}`, "error");
      return new Response(message, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  };
}
