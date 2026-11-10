/**
 * App 2, user code as ESM: a project (a set of files with entry points) whose sources are served
 * as browser-runnable ESM by webrun-modules, one module at a time, from a Durable Object.
 *
 *   PUT    /p/<id>/files/<path>          write one file of the working tree
 *   DELETE /p/<id>/files/<path>          remove it
 *   GET    /p/<id>/files                 list the working tree
 *   POST   /p/<id>/import                replace the working tree: a ZIP, or JSON { files: { path: text } }
 *   POST   /p/<id>/snapshots             freeze the working tree → { snapshot, base }
 *   GET    /p/<id>/s/<snap>/~/<path>     a source as ESM (TS, TSX, JSX, CJS; CSS as ?module), immutable
 *   GET    /p/<id>/s/<snap>/             the project's index.html
 *   POST   /p/<id>/s/<snap>/resolve      { entries: [...] } → { urls, preload }
 *   GET    /p/<id>/live/…                302 to the latest snapshot (made on demand)
 *   GET    /p/<id>/export/<snap|live>    the snapshot as a ZIP
 *
 * A snapshot id is the hash of the tree, so a snapshot's URLs never change meaning and its
 * transformed modules never go stale (webrun-modules does not invalidate a transform when its
 * source changes). Bare imports of npm packages bind to the ESM CDN's pinned URLs (a `cdn`
 * endpoint), at the ranges the project's package.json declares: the project's module server
 * transforms only the project's own files, and every project shares the CDN's cache.
 */
import { DurableObject } from "cloudflare:workers";
import type { PlatformEnv } from "@statewalker/cellb-platform-core/env";
import { registryFetch } from "@statewalker/cellb-platform-core/registry";
import { SqlFilesApi } from "@statewalker/cellb-platform-core/sql-files";
import {
  json,
  readUpload,
  safeUploadPath,
  sha256Hex,
  subtree,
  text,
  zipStream,
} from "@statewalker/cellb-platform-core/util";
import { ensureLightningCss, hasLightningCss } from "@statewalker/cellb-platform-core/wasm";
import { readFile, tryReadText } from "@statewalker/webrun-files";
import {
  type EndpointResolver,
  type ModuleServer,
  newModuleServer,
  npmRegistrySource,
  parseSpecifier,
} from "@statewalker/webrun-modules";
import { passthroughCss } from "./cdn.js";

function stubOf(ns: DurableObjectNamespace, name: string) {
  return ns.getByName ? ns.getByName(name) : ns.get(ns.idFromName(name));
}

/** Routes `/p/<id>/…` to the project's object. */
export function handleProjects(request: Request, env: PlatformEnv): Promise<Response> {
  const [, , id] = new URL(request.url).pathname.split("/");
  if (!id) return Promise.resolve(text("project id expected: /p/<id>/…\n", 400));
  return stubOf(env.PROJECTS, id).fetch(request);
}

/** The CDN's pinned URL for a bare specifier at `range` (null when the CDN cannot resolve it). */
async function cdnUrl(
  env: PlatformEnv,
  origin: string,
  spec: string,
  range?: string,
): Promise<string | null> {
  const { pkg, subpath } = parseSpecifier(spec);
  const path = `/npm/browser/${pkg}${range ? `@${encodeURIComponent(range)}` : ""}${subpath ? `/${subpath}` : ""}`;
  const res = await stubOf(env.CDN, "browser").fetch(
    new Request(`${origin}${path}`, { redirect: "manual" }),
  );
  const location = res.headers.get("location");
  await res.body?.cancel();
  return res.status === 302 && location ? new URL(location, origin).href : null;
}

export class Project extends DurableObject<PlatformEnv> {
  store: SqlFilesApi;
  out: SqlFilesApi;
  #servers = new Map<string, ModuleServer>();

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    this.store = new SqlFilesApi(ctx.storage.sql, "proj");
    this.out = new SqlFilesApi(ctx.storage.sql, "out");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS proj_state (k TEXT PRIMARY KEY, v TEXT)");
  }

  #get(k: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ v: string }>("SELECT v FROM proj_state WHERE k = ?", k)
      .toArray()[0]?.v;
  }
  #set(k: string, v: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO proj_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , id, area, ...rest] = url.pathname.split("/");
    const base = `/p/${id}`;
    let restPath: string;
    try {
      restPath = rest.map(decodeURIComponent).join("/");
    } catch {
      return text("bad path encoding\n", 400);
    }
    const SNAP = /^[0-9a-f]{16}$/; // a snapshot id: never a path segment that could climb

    if (area === "files") {
      if (!restPath && request.method === "GET")
        return json(this.store.filePaths("/live").map((p) => p.slice("/live".length)));
      // A file of the working tree: no "..", no empty name (`/live` itself is the tree).
      let path: string;
      try {
        path = `/live${safeUploadPath(restPath)}`;
      } catch (e) {
        return text(`${(e as Error).message}\n`, 400);
      }
      if (path === "/live/") return text("a file path is expected after /files/\n", 400);
      if (request.method === "PUT") {
        await this.store.write(path, [new Uint8Array(await request.arrayBuffer())]);
        this.#set("dirty", "1");
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        const removed = await this.store.remove(path);
        this.#set("dirty", "1");
        return new Response(null, { status: removed ? 204 : 404 });
      }
      const st = await this.store.stats(path);
      if (st?.kind !== "file") return text("not found\n", 404);
      return new Response((await readFile(this.store, path)) as BodyInit);
    }

    if (area === "import" && request.method === "POST") {
      let files: Map<string, Uint8Array>;
      try {
        files = await readUpload(request); // refuses entries that climb out of the tree
      } catch (e) {
        return text(`${(e as Error).message}\n`, 400);
      }
      await this.store.remove("/live");
      for (const [p, bytes] of files) await this.store.write(`/live${p}`, [bytes]);
      this.#set("dirty", "1");
      return json({ files: files.size });
    }

    if (area === "snapshots" && request.method === "POST") {
      const snapshot = await this.snapshot();
      return json({ snapshot, base: `${url.origin}${base}/s/${snapshot}/` });
    }

    if (area === "export") {
      const snap = rest[0] === "live" || !rest[0] ? await this.snapshot() : rest[0];
      if (!SNAP.test(snap)) return text("bad snapshot id\n", 400);
      const dir = `/snap/${snap}`;
      if (!(await this.store.exists(dir))) return text(`no snapshot ${snap}\n`, 404);
      const paths = this.store.filePaths(dir).map((p) => p.slice(dir.length));
      return new Response(
        zipStream(paths, (p) => readFile(this.store, `${dir}${p}`)),
        { headers: { "content-type": "application/zip", "x-snapshot": snap } },
      );
    }

    if (area === "live") {
      const snapshot =
        this.#get("dirty") === "0"
          ? (this.#get("current") ?? (await this.snapshot()))
          : await this.snapshot();
      return new Response(null, {
        status: 302,
        // The path as the request spelled it: decoded, `a%3Fb.ts` would become a query.
        headers: { location: `${base}/s/${snapshot}/${rest.join("/")}${url.search}` },
      });
    }

    if (area === "s") {
      const [snap, ...pathParts] = rest;
      if (!SNAP.test(snap ?? "")) return text("bad snapshot id\n", 400);
      if (!(await this.store.exists(`/snap/${snap}`))) return text(`no snapshot ${snap}\n`, 404);
      const server = await this.server(id, snap, url.origin);
      const inner = pathParts.join("/");
      if (inner === "" || inner === "index.html")
        return new Response(null, {
          status: 302,
          headers: { location: `${base}/s/${snap}/~/index.html` },
        });
      if (inner === "resolve" && request.method === "POST") {
        const { entries = [] } = (await request.json()) as { entries?: string[] };
        const urls: Record<string, string> = {};
        const preload = new Set<string>();
        for (const e of entries) {
          const ref = { url: `/${e.replace(/^\/+/, "")}` };
          urls[e] = (await server.resolve(ref)).url;
          for (const u of await server.listResources(ref)) preload.add(u);
        }
        return json({ urls, preload: [...preload] });
      }
      const res = await server.fetch(request);
      if (res.status !== 200) return res;
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "public, max-age=31536000, immutable");
      return out;
    }
    return text(`project ${id}: files, import, snapshots, s/<snapshot>/…, live/…\n`, 404);
  }

  /** Freezes the working tree under its content hash. */
  /**
   * Freezes the working tree under its content hash. No other request of this object runs
   * meanwhile: a write between hashing and copying would freeze content that does not match
   * the snapshot's name.
   */
  snapshot(): Promise<string> {
    return this.ctx.blockConcurrencyWhile(() => this.#snapshot());
  }

  async #snapshot(): Promise<string> {
    const paths = this.store.filePaths("/live");
    const parts: string[] = [];
    for (const p of paths) parts.push(`${p}\0${await sha256Hex(await readFile(this.store, p))}`);
    const snapshot = (await sha256Hex(parts.join("\n"))).slice(0, 16);
    if (!(await this.store.exists(`/snap/${snapshot}`))) {
      if (paths.length) await this.store.copy("/live", `/snap/${snapshot}`);
      else await this.store.mkdir(`/snap/${snapshot}`);
    }
    this.#set("current", snapshot);
    this.#set("dirty", "0");
    return snapshot;
  }

  async server(id: string, snap: string, origin: string): Promise<ModuleServer> {
    let server = this.#servers.get(snap);
    if (server) return server;
    await ensureLightningCss();
    const project = subtree(this.store, `/snap/${snap}`);
    const manifest = JSON.parse((await tryReadText(project, "/package.json")) ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const ranges = { ...manifest.devDependencies, ...manifest.dependencies };
    const env = this.env;
    const local = new Map<string, Promise<string | null>>();
    // Bare specifiers of the project's files bind to the CDN's pinned URL, at the project's range.
    const resolveEndpoint: EndpointResolver = {
      async resolve(specifier) {
        const { pkg } = parseSpecifier(specifier);
        let p = local.get(specifier);
        if (!p) {
          p = cdnUrl(env, origin, specifier, ranges[pkg]);
          local.set(specifier, p);
        }
        const url = await p;
        if (!url) throw new Error(`the ESM CDN cannot resolve "${specifier}"`);
        return { kind: "cdn", url };
      },
    };
    server = newModuleServer({
      project,
      cache: subtree(this.out, `/${snap}`),
      sources: [npmRegistrySource({ fetch: registryFetch(env) })],
      basePath: `/p/${id}/s/${snap}/`,
      target: "browser",
      resolveEndpoint,
      cors: true,
      ...(hasLightningCss() ? {} : { css: passthroughCss }),
    });
    this.#servers.set(snap, server);
    return server;
  }
}
