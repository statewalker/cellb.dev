/**
 * The package store: a caching proxy of the npm registry, one Durable Object per package name.
 *
 * Every component that needs npm packages (the ESM CDN, the project module servers, the bundler,
 * the notebook builder, and the Node build runner over HTTP) loads them through
 * webrun-modules' `npmRegistrySource({ fetch })`, with a `fetch` that sends registry requests
 * here instead of to registry.npmjs.org:
 *
 *   GET /registry/<name>                     packument: cached for PACKUMENT_TTL_S, slimmed
 *                                            (readme and time dropped), stale on registry errors
 *   GET /registry/<name>/-/<file>.tgz        tarball: immutable, cached forever
 *
 * Sharding by package name keeps each object's working set to one package, and lets every
 * package be fetched and stored concurrently.
 */
import { DurableObject } from "cloudflare:workers";
import { readFile } from "@statewalker/webrun-files";
import { DEFAULT_REGISTRY, parseRegistryPath, type RegistryEnv, stub } from "./registry-fetch.js";
import { SqlFilesApi } from "./sql-files.js";

export { type RegistryEnv, registryFetch, remoteRegistryFetch } from "./registry-fetch.js";

/** Routes `/registry/*` of the platform to the package store. */
export function handleRegistry(request: Request, env: RegistryEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice("/registry".length);
  const doc = parseRegistryPath(path);
  if (!doc)
    return Promise.resolve(
      new Response("expected /registry/<name> or /registry/<name>/-/<file>.tgz", { status: 400 }),
    );
  return stub(env.REGISTRY, doc.name).fetch(`http://registry/registry${path}`);
}

interface Meta {
  readme?: unknown;
  time?: unknown;
  users?: unknown;
  versions?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

/** Drops the fields no resolver reads; they are most of a large packument. */
function slim(meta: Meta): Meta {
  const { readme: _r, time: _t, users: _u, ...rest } = meta;
  const versions: Record<string, Record<string, unknown>> = {};
  for (const [v, m] of Object.entries(meta.versions ?? {})) {
    const { readme: _vr, ...vm } = m;
    versions[v] = vm;
  }
  return { ...rest, versions };
}

export class PackageRegistry extends DurableObject<RegistryEnv> {
  files: SqlFilesApi;

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    this.files = new SqlFilesApi(ctx.storage.sql, "reg");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reg_meta (path TEXT PRIMARY KEY, fetched INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice("/registry".length);
    const registry = (this.env.REGISTRY_URL ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    const doc = parseRegistryPath(path);
    if (!doc) return new Response("not a packument or tarball path", { status: 400 });
    const isTarball = doc.kind === "tarball";
    // Keys and the upstream URL come from the parsed name, not from the request's spelling.
    const key = isTarball
      ? `/tgz/${doc.name}/${doc.file}`
      : `/meta/${encodeURIComponent(doc.name)}.json`;
    const upstreamPath = isTarball
      ? `/${doc.name}/-/${doc.file}`
      : `/${doc.name.replace("/", "%2f")}`;
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ fetched: number }>("SELECT fetched FROM reg_meta WHERE path = ?", key)
      .toArray()[0];
    const ttl = Number(this.env.PACKUMENT_TTL_S ?? 600) * 1000;
    const fresh = row && (isTarball || Date.now() - Number(row.fetched) < ttl);
    const type = isTarball ? "application/octet-stream" : "application/json";
    if (fresh)
      return new Response((await readFile(this.files, key)) as BodyInit, {
        headers: { "content-type": type, "x-cache": "hit" },
      });

    let upstream: Response;
    try {
      upstream = await fetch(`${registry}${upstreamPath}`);
    } catch (e) {
      if (row)
        return new Response((await readFile(this.files, key)) as BodyInit, {
          headers: { "content-type": type, "x-cache": "stale" },
        });
      return new Response(`registry unreachable: ${e}`, { status: 502 });
    }
    if (!upstream.ok) {
      if (row && upstream.status >= 500)
        return new Response((await readFile(this.files, key)) as BodyInit, {
          headers: { "content-type": type, "x-cache": "stale" },
        });
      return new Response(await upstream.text(), { status: upstream.status });
    }
    const bytes = isTarball
      ? new Uint8Array(await upstream.arrayBuffer())
      : new TextEncoder().encode(JSON.stringify(slim((await upstream.json()) as Meta)));
    await this.files.write(key, [bytes]);
    sql.exec(
      "INSERT INTO reg_meta (path, fetched) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET fetched = excluded.fetched",
      key,
      Date.now(),
    );
    return new Response(bytes as BodyInit, {
      headers: { "content-type": type, "x-cache": "miss" },
    });
  }
}
