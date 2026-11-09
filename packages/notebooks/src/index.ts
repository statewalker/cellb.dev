/**
 * Observable notebooks compiled to pages in a Durable Object: user code as ESM for notebooks.
 *
 *   PUT  /nb/<site>/files/<path>      write a notebook (.md, notebook-kit .html) or a data file
 *   POST /nb/<site>/import            replace the sources: a ZIP, or JSON { files: { path: text } }
 *   POST /nb/<site>/build             build the pages (incremental) → { changed, failures, ms }
 *   GET  /nb/<site>/<page>.html       a built page; its cells run in the browser
 *   GET  /nb/<site>/_m/…              the npm modules the pages import (webrun-modules)
 *
 * The build is `@statewalker/notebook-build` in hosted mode: Markdown and notebook-kit HTML
 * become pages that import notebook-kit's runtime and their own `npm:` imports from the site's
 * module server, which takes packages from the platform's package store. The DOM the build needs
 * is linkedom's, so it runs in a Workers isolate.
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
  #server?: ModuleServer;
  #building?: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    this.sources = new SqlFilesApi(ctx.storage.sql, "nbsrc");
    this.output = new SqlFilesApi(ctx.storage.sql, "nbout");
    this.cache = new SqlFilesApi(ctx.storage.sql, "nbcache");
    this.modules = new SqlFilesApi(ctx.storage.sql, "nbmod");
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
    return {
      changed,
      failures,
      ms: Date.now() - t,
      pages: this.output.filePaths("/").filter((p) => p.endsWith(".html")),
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
