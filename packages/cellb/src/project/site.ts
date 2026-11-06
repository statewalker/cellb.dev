import { type FilesApi, readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newDefaultTransform, newModuleServer, type Transform } from "@statewalker/webrun-modules";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";
import { nativeAsyncContext } from "../core/async-context.js";
import { NODE_POLYFILL_FILES, NODE_POLYFILL_PACKAGES } from "../node-compat/modules.js";
import { lowerAwait } from "./lower-await.js";
import { SCHEDULER_EXPRESSION } from "./scheduler.js";
import { ESM_HEADER, LOADED_CONSOLES, WORKERS_MODULE_NAMES } from "./site-loader.js";
import { WORKERS_GLOBAL_NAMES } from "./workers-global-names.js";

/** webrun-modules' transform, then `lowerAwait` on its output. */
function loweringTransform(): Transform {
  const base = newDefaultTransform(true);
  return {
    async transform(file, rewrite) {
      const r = await base.transform(file, rewrite);
      return { ...r, code: lowerAwait(r.code) };
    },
  };
}

/**
 * A project served by an in-browser "HTTP server" (webrun-site-builder handler, hosted in a
 * ServiceWorker by webrun-site-host): the browser's own module loader then fetches the
 * Worker code from real URLs — no bundling, no Blob URLs.
 *
 *   GET  /modules/~/<path>        the project's sources compiled to ESM by webrun-modules
 *   PUT  /loaded-src/<id>/<file>  a Worker Loader stores the modules of loaded code
 *   GET  /loaded/<id>/~/<file>    loaded code compiled to ESM by webrun-modules
 *   GET  /src/<path>              raw project files
 *
 * `cloudflare:workers` and the Workers globals (`Response` with status 101, `WebSocketPair`)
 * are webrun-modules `~deps` proxies that read `globalThis.__webrunHostRegistry` in the realm
 * that imports the code (see `workersHostRegistry`). Each loaded Worker gets its own module
 * server whose `console` proxy selects that Worker's console (Tail Workers).
 */
export function createProjectSite(opts: {
  projectFiles: FilesApi;
  /**
   * nodejs_compat: serves the `node:*` modules, and (see `lowerAwait`) lowers the modules' awaits
   * to generators so that AsyncLocalStorage stores follow them. It must match the project's flag:
   * without AsyncContext, the browser host makes continuations carry stores for a nodejs_compat
   * project, which awaits that are not lowered would not see.
   */
  nodeCompat?: boolean;
  /**
   * Lower `await` in the modules served. Default: with `nodeCompat`, unless this browser has
   * AsyncContext (the engine then carries the stores through native awaits, as workerd does).
   */
  lowerAwait?: boolean;
  /**
   * The `node:*` registry entries of the realm that runs the code (`nodeRegistryEntries`): a
   * namespace import (`import * as assert from "node:assert"`) exports the keys the server
   * sees here, so without them its members are undefined.
   */
  nodeModules?: Record<string, unknown>;
}): SiteHandler {
  const host = "globalThis.__webrunHostRegistry.get";
  // nodejs_compat: node:* and the Buffer/process globals come from the realm's registry too.
  // A namespace import (`import * as cf`) exports the keys the server sees here.
  const provided: Record<string, object> = {
    "cloudflare:workers": Object.fromEntries(WORKERS_MODULE_NAMES.map((n) => [n, null])),
    "cloudflare:email": { EmailMessage: null },
  };
  if (opts.nodeCompat)
    for (const name of [
      ...Object.keys(NODE_POLYFILL_PACKAGES),
      ...Object.keys(NODE_POLYFILL_FILES),
    ])
      provided[name] = (opts.nodeModules?.[name] as object) ?? {};
  const globals = {
    ...Object.fromEntries(WORKERS_GLOBAL_NAMES.map((n) => [n, `${host}(${JSON.stringify(n)})`])),
    scheduler: SCHEDULER_EXPRESSION,
    ...(opts.nodeCompat ? { Buffer: `${host}("Buffer")`, process: `${host}("process")` } : {}),
  };
  // nodejs_compat without AsyncContext: awaits lowered to generators, so that AsyncLocalStorage
  // stores follow them (the browser host installs the polyfill's continuations for such a project).
  const lower = opts.lowerAwait ?? (!!opts.nodeCompat && !nativeAsyncContext());
  const transform = lower ? loweringTransform() : undefined;
  const modules = newModuleServer({
    cache: new MemFilesApi(),
    project: opts.projectFiles,
    basePath: "/modules/",
    target: "browser",
    provided,
    globals,
    transform,
  });
  // One module server per loaded Worker: its globals proxy (one per project root in
  // webrun-modules) can then bind `console` to that Worker's own console (Tail Workers).
  // `esm`: modules stored as ESM already (text, json, wasm entries), served as they are: the
  // module server would serve `math.wasm` or `text.txt` by their extension.
  const loaded = new Map<
    string,
    { files: FilesApi; server: ReturnType<typeof newModuleServer>; esm: Set<string> }
  >();
  const loadedFor = (id: string) => {
    let l = loaded.get(id);
    if (!l) {
      const files = new MemFilesApi();
      const server = newModuleServer({
        cache: new MemFilesApi(),
        project: files,
        basePath: `/loaded/${encodeURIComponent(id)}/`,
        target: "browser",
        provided,
        transform,
        globals: {
          ...globals,
          console: `(globalThis.${LOADED_CONSOLES}?.[${JSON.stringify(id)}] ?? globalThis.console)`,
          fetch: `(globalThis.__cellsLoadedOutbound?.[${JSON.stringify(id)}] ?? globalThis.fetch)`,
        },
      });
      l = { files, server, esm: new Set() };
      loaded.set(id, l);
    }
    return l;
  };
  return new SiteBuilder()
    .setEndpoint("/modules/*", (req) => modules.fetch(req))
    .setEndpoint("/loaded/:id/*", async (req, env) => {
      const l = loadedFor(decodeURIComponent(String(env.params.id)));
      const path = decodeURIComponent(
        new URL(req.url).pathname.slice(`/loaded/${env.params.id}/~`.length),
      );
      if (!l.esm.has(path)) return l.server.fetch(req);
      return new Response(await readText(l.files, path), {
        headers: { "content-type": "text/javascript" },
      });
    })
    .setEndpoint("/loaded-src/:id/*", "PUT", async (req, env) => {
      const id = decodeURIComponent(String(env.params.id));
      const path = decodeURIComponent(
        new URL(req.url).pathname.slice(`/loaded-src/${env.params.id}`.length),
      );
      const l = loadedFor(id);
      await l.files.write(path, [new Uint8Array(await req.arrayBuffer())]);
      if (req.headers.has(ESM_HEADER)) l.esm.add(path);
      return new Response(null, { status: 204 });
    })
    .setFiles("/src", opts.projectFiles)
    .build();
}
