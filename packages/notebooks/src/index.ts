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
import { json, readUpload, text } from "@statewalker/cellb-platform-core/util";
import { ensureLightningCss, hasLightningCss } from "@statewalker/cellb-platform-core/wasm";
import { type NotebookFailure, newNotebookBuild } from "@statewalker/notebook-build";
import { newNotebookSite } from "@statewalker/notebook-site";
import { type ModuleServer, newModuleServer, npmRegistrySource } from "@statewalker/webrun-modules";
import { DOMParser, parseHTML } from "linkedom";
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
  site: PageModels["site"];
  pages: Record<string, PageModels["pages"][number]>;
}

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
  #server?: ModuleServer;
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
      site: models.site,
      pages: Object.fromEntries(models.pages.map((p) => [p.id, p])),
    };
    await this.#writeJson("/models.json", stored);
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
      const { version: _v, ...data } = models;
      return { ...payload, env: { NOTEBOOK_MODELS: data }, globalOutbound: null };
    });
    const inner = new URL(request.url);
    inner.pathname = path;
    return worker.getEntrypoint().fetch(new Request(inner, request));
  }

  moduleServer(site: string): ModuleServer {
    this.#server ??= newModuleServer({
      cache: this.modules,
      sources: [npmRegistrySource({ fetch: registryFetch(this.env) })],
      basePath: `/nb/${site}/_m/`,
      target: "browser",
      ...(hasLightningCss() ? {} : { css: passthroughCss }),
    });
    return this.#server;
  }

  async build(site: string) {
    await ensureLightningCss();
    const moduleServer = this.moduleServer(site);
    const basePath = `/nb/${site}/_m/`;
    const styles = await moduleServer.resolve({
      pkg: "@observablehq/notebook-kit",
      subpath: "dist/src/styles/index.css",
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
