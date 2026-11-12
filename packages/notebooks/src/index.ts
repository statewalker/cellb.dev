/**
 * Observable notebooks compiled to pages in a Durable Object: user code as ESM for notebooks.
 *
 *   PUT  /nb/<site>/files/<path>      write a notebook (.md, notebook-kit .html) or a data file
 *   POST /nb/<site>/import            replace the sources: a ZIP, or JSON { files: { path: text } }
 *   POST /nb/<site>/build             build the pages (incremental) → { changed, failures, ms }
 *   GET  /nb/<site>/<page>.html       a built page; its cells run in the browser
 *   GET  /nb/<site>/_m/…              the npm modules the pages import (webrun-modules)
 *   GET  /nb/<site>/models.json       the page models of the last build (page-models.ts)
 *   PUT  /nb/<site>/theme             { build: <id> }: a bundler build of an Astro theme
 *   GET  /nb/<site>/t/<page>          a page rendered by the theme, from the page models
 *   POST /nb/<site>/export            the themed site as static files, a ZIP
 *   GET  /nb/<site>/search.json       the search index of the last build (search.ts)
 *
 * The build is `@statewalker/notebook-build` in hosted mode: Markdown and notebook-kit HTML
 * become pages that import notebook-kit's runtime and their own `npm:` imports from the site's
 * module server, which takes packages from the platform's package store. The DOM the build needs
 * is linkedom's, so it runs in a Workers isolate.
 *
 * Themed pages: the build also writes page models (prose, outline, cell ids, the module script),
 * and a theme (an Astro project built by the platform's bundler, `packages/notebooks/theme` by
 * default) renders them. The theme's build runs in a Worker Loader isolate whose env holds the
 * models as plain JSON (`NOTEBOOK_MODELS`), so a notebook edit and rebuild change the data the
 * theme reads, never the theme's build.
 */
import "urlpattern-polyfill";
import { DurableObject } from "cloudflare:workers";
import { passthroughCss } from "@statewalker/cellb-esm-cdn";
import type { PlatformEnv } from "@statewalker/cellb-platform-core/env";
import { registryFetch } from "@statewalker/cellb-platform-core/registry";
import { SqlFilesApi } from "@statewalker/cellb-platform-core/sql-files";
import { json, readUpload, text, zip } from "@statewalker/cellb-platform-core/util";
import { ensureLightningCss, hasLightningCss } from "@statewalker/cellb-platform-core/wasm";
import {
  ASSET_EXTENSIONS,
  materializeDeps,
  type NotebookFailure,
  newNotebookBuild,
} from "@statewalker/notebook-build";
import { newNotebookSite } from "@statewalker/notebook-site";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newModuleServer, npmRegistrySource } from "@statewalker/webrun-modules";
import { DOMParser, parseHTML } from "linkedom";
import { builtinClosure, type LocalBuiltinsServer, withLocalBuiltins } from "./builtins.js";
import { buildPageModels, type PageModels } from "./page-models.js";

export type { OutlineEntry, PageBlock, PageModel, PageModels, SiteModel } from "./page-models.js";

/** What `env.LOADER.get(id, () => code)` returns: the Worker's entrypoint. */
interface WorkerLoaderLike {
  get(
    id: string,
    code: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
}

/** The page models as the theme reads them, with the version that names its loader isolate. */
interface StoredModels {
  version: string;
  pins: PageModels["pins"];
  inputs: PageModels["inputs"];
  site: PageModels["site"];
  pages: Record<string, PageModels["pages"][number]>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stubOf(ns: DurableObjectNamespace, name: string) {
  return ns.getByName ? ns.getByName(name) : ns.get(ns.idFromName(name));
}

export function handleNotebooks(request: Request, env: PlatformEnv): Promise<Response> {
  const [, , site] = new URL(request.url).pathname.split("/");
  if (!site) return Promise.resolve(text("site expected: /nb/<site>/…\n", 400));
  return stubOf(env.NOTEBOOKS, site).fetch(request);
}

export class NotebookSite extends DurableObject<PlatformEnv> {
  sources: SqlFilesApi;
  output: SqlFilesApi;
  cache: SqlFilesApi;
  modules: SqlFilesApi;
  /** `/models.json` (the page models) and `/theme.json` (the theme's build id). */
  meta: SqlFilesApi;
  #server?: LocalBuiltinsServer;
  #building?: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    this.sources = new SqlFilesApi(ctx.storage.sql, "nbsrc");
    this.output = new SqlFilesApi(ctx.storage.sql, "nbout");
    this.cache = new SqlFilesApi(ctx.storage.sql, "nbcache");
    this.modules = new SqlFilesApi(ctx.storage.sql, "nbmod");
    this.meta = new SqlFilesApi(ctx.storage.sql, "nbmeta");
  }

  async #readJson<T>(path: string): Promise<T | undefined> {
    if (!(await this.meta.exists(path))) return undefined;
    const chunks: Uint8Array[] = [];
    for await (const c of this.meta.read(path)) chunks.push(c);
    return JSON.parse(new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer()));
  }

  async #writeJson(path: string, value: unknown) {
    await this.meta.write(path, [new TextEncoder().encode(JSON.stringify(value))]);
  }

  /** The page models of every notebook, for a theme; written with each build. */
  async buildModels(site: string, dom: { document: unknown; parser: unknown }) {
    const models = await buildPageModels({
      notebooks: this.sources,
      moduleServer: this.moduleServer(site),
      dom: dom as never,
      siteTitle: site,
      base: `/nb/${site}/t`,
      searchUrl: `/nb/${site}/search.json`,
    });
    const home = models.pages.find((p) => p.id === "index");
    if (home) models.site.title = home.title;
    const body = JSON.stringify({ site: models.site, pages: models.pages });
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
    const version = [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const stored: StoredModels = {
      version,
      pins: models.pins,
      inputs: models.inputs,
      site: models.site,
      pages: Object.fromEntries(models.pages.map((p) => [p.id, p])),
    };
    await this.#writeJson("/models.json", stored);
    await this.#writeJson("/search.json", models.search);
    return { models: models.pages.length, modelFailures: models.failures };
  }

  /** A page of the theme: its build in a Worker Loader isolate, the page models in its env. */
  async themed(request: Request, site: string, path: string): Promise<Response> {
    const theme = await this.#readJson<{ build: string }>("/theme.json");
    if (!theme) return text(`no theme: PUT /nb/${site}/theme { "build": "<build id>" }\n`, 404);
    const models = await this.#readJson<StoredModels>("/models.json");
    if (!models) return text(`no page models: POST /nb/${site}/build first\n`, 404);
    const builds = stubOf(this.env.BUILDS, theme.build);
    const origin = new URL(request.url).origin;
    // The theme's own client files (its assets/) first, then its pages.
    if (path !== "/" && !path.endsWith("/")) {
      const asset = await builds.fetch(`${origin}/b/${theme.build}/assets${path}`);
      if (asset.ok) return asset;
    }
    const loader = this.env.LOADER as WorkerLoaderLike | undefined;
    if (!loader) return text("this host has no Worker Loader (worker_loaders)\n", 501);
    const worker = loader.get(`nb-theme:${theme.build}:${models.version}`, async () => {
      const res = await builds.fetch(`${origin}/b/${theme.build}/loader.json`);
      if (!res.ok) throw new Error(`theme build ${theme.build}: loader.json ${res.status}`);
      const payload = (await res.json()) as Record<string, unknown>;
      const { version: _v, pins: _p, inputs: _i, ...data } = models;
      return { ...payload, env: { NOTEBOOK_MODELS: data }, globalOutbound: null };
    });
    const inner = new URL(request.url);
    inner.pathname = path;
    return worker.getEntrypoint().fetch(new Request(inner, request));
  }

  /** The site's module server. notebook-kit's esm.sh imports come out as its own URLs (builtins.ts). */
  moduleServer(site: string): LocalBuiltinsServer {
    this.#server ??= withLocalBuiltins(
      newModuleServer({
        cache: this.modules,
        sources: [npmRegistrySource({ fetch: registryFetch(this.env) })],
        basePath: `/nb/${site}/_m/`,
        target: "browser",
        ...(hasLightningCss() ? {} : { css: passthroughCss }),
      }),
      `/nb/${site}/_m/`,
    );
    return this.#server;
  }

  async build(site: string) {
    await ensureLightningCss();
    const moduleServer = this.moduleServer(site);
    const basePath = `/nb/${site}/_m/`;
    // notebook-kit exports its stylesheets as `"./*.css": "./dist/src/styles/*.css"`: the subpath
    // is `index.css`. The file's own path (`dist/src/styles/index.css`) went through that pattern
    // too, and came out as `dist/src/styles/dist/src/styles/index.css`, a 404.
    const styles = await moduleServer.resolve({
      pkg: "@observablehq/notebook-kit",
      subpath: "index.css",
    });
    const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
    const changed: string[] = [];
    const failures: { notebook: string; error: string }[] = [];
    const t = Date.now();
    const build = newNotebookBuild({
      notebooks: this.sources,
      output: this.output,
      cache: this.cache,
      moduleServer,
      dom: { document, parser: new DOMParser() } as never,
      mode: "hosted",
      basePath,
      stylesUrl: styles.url,
      onRebuilt: (paths: string[]) => changed.push(...paths),
      onFailed: (f: NotebookFailure[] | NotebookFailure) => {
        for (const x of Array.isArray(f) ? f : [f])
          failures.push({
            notebook: x.notebookPath,
            error: String((x.error as Error)?.message ?? x.error),
          });
      },
    });
    await build.build();
    const themed = await this.buildModels(site, { document, parser: new DOMParser() });
    return {
      changed,
      failures,
      ms: Date.now() - t,
      pages: this.output.filePaths("/").filter((p) => p.endsWith(".html")),
      ...themed,
    };
  }

  /**
   * The themed site as static files: the theme's pages, crawled from `/nb/<site>/t/` through
   * their links, and the modules they import (a crawler cannot see those: the pages import them
   * from JavaScript), materialized from the page models' pins. Paths stay as served, so nothing
   * is rewritten: serve the ZIP's root, and `index.html` there redirects to the home page.
   */
  async exportSite(request: Request, site: string): Promise<Response> {
    if (!(await this.#readJson("/theme.json")))
      return text(`no theme: PUT /nb/${site}/theme { "build": "<build id>" }\n`, 404);
    const models = await this.#readJson<StoredModels>("/models.json");
    if (!models) return text(`no page models: POST /nb/${site}/build first\n`, 404);
    const origin = new URL(request.url).origin;
    const prefix = `/nb/${site}`;
    const out = new Map<string, Uint8Array>();
    const addFiles = async (files: MemFilesApi, paths: string[]) => {
      for (const p of paths) {
        const chunks: Uint8Array[] = [];
        for await (const c of files.read(p)) chunks.push(c);
        out.set(p.slice(1), new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()));
      }
    };

    // The modules: the pins' whole closure, with the .css/.wasm/font files their packages ship.
    await ensureLightningCss();
    const modules = new MemFilesApi();
    const written = await materializeDeps(
      new Map(Object.entries(models.pins)),
      this.moduleServer(site),
      modules,
      `${prefix}/_m/`,
    );
    await addFiles(modules, written);
    const builtins = await this.#builtinFiles(out, site, models);
    const asModules = await this.#staticModuleImports(out, site);
    // A static server cannot redirect: the `~esm/` URLs of the built-ins the export holds become
    // the pinned URLs they redirect to (`builtins.ts`). Others stay, for libraries no cell uses.
    if (builtins.aliases.size) {
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      for (const [path, bytes] of out) {
        if (!/\.(m?js|css)$/.test(path)) continue;
        const text = dec.decode(bytes);
        if (!text.includes("/~esm/")) continue;
        let next = text;
        // a URL ends at a quote, or an escaped one (`\"`: CSS inside a JS string)
        for (const [from, to] of builtins.aliases)
          next = next.replace(new RegExp(`${escapeRegExp(from)}(?=\\\\?["'])`, "g"), to);
        if (next !== text) out.set(path, enc.encode(next));
      }
    }

    // The pages, and any other same-site file they link (a theme asset, a stylesheet).
    const queue = [`${prefix}/t/`];
    const seen = new Set(queue);
    const failed: string[] = [];
    while (queue.length) {
      const path = queue.shift() as string;
      const res = path.startsWith(`${prefix}/t/`)
        ? await this.themed(new Request(origin + path), site, path.slice(`${prefix}/t`.length))
        : await this.fetch(new Request(origin + path));
      if (!res.ok) {
        failed.push(`${path} ${res.status}`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const html = (res.headers.get("content-type") ?? "").includes("text/html");
      out.set(html ? `${path.replace(/\/$/, "")}/index.html`.slice(1) : path.slice(1), bytes);
      if (!html) continue;
      // Links in the markup only: a script's text is code (the theme's search script builds
      // `href="${…}"` strings), not links to follow.
      const markup = new TextDecoder()
        .decode(bytes)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
      for (const [, link] of markup.matchAll(/(?:href|src)="([^"#?]+)/g)) {
        const u = new URL(link, origin + path);
        if (u.origin !== origin || !u.pathname.startsWith(`${prefix}/`)) continue;
        if (seen.has(u.pathname) || out.has(u.pathname.slice(1))) continue;
        seen.add(u.pathname);
        queue.push(u.pathname);
      }
    }
    if (failed.length) return text(`export: ${failed.join(", ")}\n`, 502);
    // The search index: the theme fetches it from JavaScript, so no crawl finds it.
    const search = await this.#readJson<unknown>("/search.json");
    if (search)
      out.set(`${prefix.slice(1)}/search.json`, new TextEncoder().encode(JSON.stringify(search)));
    const home = `${prefix}/t/`;
    out.set(
      "index.html",
      new TextEncoder().encode(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${home}"><a href="${home}">${models.site.title}</a>\n`,
      ),
    );
    const pages = [...out.keys()].filter(
      (p) => p.startsWith(`${prefix.slice(1)}/t/`) && p.endsWith(".html"),
    );
    return new Response(zip(out) as BodyInit, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${site}-site.zip"`,
        "x-export-pages": String(pages.length),
        "x-export-modules": String(written.length + builtins.files + asModules),
        "x-export-builtins": builtins.names.join(","),
      },
    });
  }

  /**
   * The files of the notebook-kit built-ins the site's cells use (`Inputs`, `Plot`, `tex`…): the
   * pins' closure does not hold them, since notebook-kit loads them on first use. Each library's
   * modules (static imports followed), and the assets its package ships, which CSS reaches
   * through `url()` (KaTeX's fonts).
   */
  async #builtinFiles(out: Map<string, Uint8Array>, site: string, models: StoredModels) {
    const server = this.moduleServer(site);
    const get = (url: string) => server.fetch(new Request(`http://local${url}`));
    const runtimeUrl = models.pins["npm:@observablehq/notebook-kit/runtime"];
    if (!runtimeUrl) return { files: 0, names: [] as string[], aliases: new Map<string, string>() };
    const { urls, names, aliases } = await builtinClosure({
      runtimeUrl,
      used: models.inputs,
      fetchText: async (url) => {
        const res = await get(url);
        return res.ok ? res.text() : undefined;
      },
      resolve: (url) => server.resolveEsm(url),
      have: (url) => out.has(url.split("?")[0]?.slice(1) ?? ""),
    });
    let files = 0;
    // `x.worker.js?raw` (a classic worker script, untransformed) is saved at its plain path.
    const add = async (url: string) => {
      const path = (url.split("?")[0] ?? url).slice(1);
      if (out.has(path)) return;
      const res = await get(url);
      if (!res.ok) throw new Error(`export: ${url} ${res.status}`);
      out.set(path, new Uint8Array(await res.arrayBuffer()));
      files++;
    };
    for (const url of urls) await add(url);
    const base = `/nb/${site}/_m/`;
    const packages = new Set<string>();
    for (const url of urls) {
      const m = /^((?:@[^/]+\/)?[^/@]+)@([^/]+)\//.exec(url.slice(base.length));
      if (url.startsWith(base) && m) packages.add(`${m[1]}\0${m[2]}`);
    }
    for (const key of packages) {
      const [pkg, version] = key.split("\0") as [string, string];
      for (const file of await server.listPackageFiles({ pkg, version }))
        if (ASSET_EXTENSIONS.some((ext) => file.endsWith(ext)))
          await add(`${base}${pkg}@${version}/${file.replace(/^\//, "")}`);
    }
    return { files, names, aliases };
  }

  /**
   * `import "./x.css?module"`: the module server answers a file with `?module` as a JS module (a
   * stylesheet that adopts itself), but a static file server ignores the query and sends the CSS,
   * which a browser refuses as a module script (notebook-kit's `stdlib/inputs.js` does this).
   * Each such import is rewritten to `./x.css.module.js`, and that file is the module server's
   * answer for `x.css?module`. Returns how many files were added.
   */
  async #staticModuleImports(out: Map<string, Uint8Array>, site: string): Promise<number> {
    const server = this.moduleServer(site);
    const QUERY = /(["'])([^"'\s]+?)\?module\1/g;
    let added = 0;
    for (const [path, bytes] of [...out]) {
      if (!path.endsWith(".js")) continue;
      const source = new TextDecoder().decode(bytes);
      if (!source.includes("?module")) continue;
      const base = new URL(`http://local/${path}`);
      for (const [, , spec] of source.matchAll(QUERY)) {
        const url = new URL(spec, base);
        const target = `${url.pathname.slice(1)}.module.js`;
        if (out.has(target)) continue;
        const res = await server.fetch(new Request(`${url.href}?module`));
        if (!res.ok) throw new Error(`export: ${url.pathname}?module ${res.status}`);
        out.set(target, new Uint8Array(await res.arrayBuffer()));
        added++;
      }
      out.set(path, new TextEncoder().encode(source.replace(QUERY, "$1$2.module.js$1")));
    }
    return added;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , site, area, ...rest] = url.pathname.split("/");
    const prefix = `/nb/${site}`;
    if (area === "files" && request.method === "PUT") {
      await this.sources.write(`/${rest.map(decodeURIComponent).join("/")}`, [
        new Uint8Array(await request.arrayBuffer()),
      ]);
      return new Response(null, { status: 204 });
    }
    if (area === "import" && request.method === "POST") {
      const files = await readUpload(request);
      await this.sources.remove("/");
      for (const [p, b] of files) await this.sources.write(p, [b]);
      return json({ files: files.size });
    }
    if (area === "build" && request.method === "POST") {
      // One build at a time: a second request waits for the running one, then builds again.
      while (this.#building) await this.#building.catch(() => {});
      const run = this.build(site);
      this.#building = run;
      try {
        return json(await run);
      } finally {
        this.#building = undefined;
      }
    }
    if (area === "search.json" && rest.length === 0) {
      const search = await this.#readJson<unknown>("/search.json");
      return search ? json(search) : text("no search index: build first\n", 404);
    }
    if (area === "models.json" && rest.length === 0) {
      const models = await this.#readJson<StoredModels>("/models.json");
      return models ? json(models) : text("no page models: build first\n", 404);
    }
    if (area === "theme" && rest.length === 0 && request.method === "PUT") {
      const { build } = (await request.json()) as { build?: string };
      if (!build || !/^[\w-]+$/.test(build)) return text("{ build: <build id> } expected\n", 400);
      await this.#writeJson("/theme.json", { build });
      return new Response(null, { status: 204 });
    }
    if (area === "export" && rest.length === 0 && request.method === "POST") {
      return this.exportSite(request, site);
    }
    if (area === "t") {
      return this.themed(request, site, `/${rest.map(decodeURIComponent).join("/")}`);
    }
    if (area === "_m") {
      await ensureLightningCss();
      return this.moduleServer(site).fetch(request);
    }
    // Pages and attachments: the built output, as notebook-site serves it (modules handled above).
    const inner = new URL(request.url);
    inner.pathname = url.pathname.slice(prefix.length) || "/";
    const handler = newNotebookSite({ output: this.output, basePath: "/_m/" });
    return handler(new Request(inner, request));
  }
}
