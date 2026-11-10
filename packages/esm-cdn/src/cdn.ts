/**
 * App 1, the ESM CDN: npm packages transformed to ESM by webrun-modules, served from a
 * Durable Object's storage.
 *
 *   GET /npm/<profile>/<name>[@<range>][/<subpath>]   302 to the pinned URL
 *   GET /npm/<profile>/<name>@<version>/<file>        transformed ESM (immutable)
 *   GET /npm/<profile>/<name>[@<range>]?meta          the package's file list
 *   GET /npm/<profile>/<name>[@<range>][/sub]?graph   every URL the entry needs (preload list)
 *   GET …/<file>?raw                                  the file's original bytes
 *
 * `profile` is `browser` (node:* replaced by @jspm/core polyfills) or `node` (node:* left to
 * the runtime). One `ModuleHost` object per profile holds that profile's module server; packages
 * come from the package store (`PackageRegistry`), so the CDN never talks to the registry itself.
 */
import { DurableObject } from "cloudflare:workers";
import { type RegistryEnv, registryFetch } from "@statewalker/cellb-platform-core/registry";
import { SqlFilesApi } from "@statewalker/cellb-platform-core/sql-files";
import { CORS, json, text } from "@statewalker/cellb-platform-core/util";
import { ensureLightningCss, hasLightningCss } from "@statewalker/cellb-platform-core/wasm";
import {
  type CssTransform,
  type ModuleServer,
  newModuleServer,
  npmRegistrySource,
} from "@statewalker/webrun-modules";

export interface CdnEnv extends RegistryEnv {
  CDN: DurableObjectNamespace;
}

export const PROFILES = ["browser", "node"] as const;
export type Profile = (typeof PROFILES)[number];

/** A CSS transform that wraps the stylesheet as is: for hosts that were given no lightningcss.wasm. */
export const passthroughCss: CssTransform = {
  async transform(file) {
    return { code: file.source, exports: {} };
  },
};

/**
 * Splits `<name>[@<range>][/<subpath>]` (scope-aware), from the path as the request spelled it:
 * split on "/" first, then each segment decoded, so a range with an encoded "/" or "@"
 * (`github:u%2Fr`, `npm:x%401`) stays one range. `undefined` for a malformed spec.
 */
export function parseSpec(
  raw: string,
): { pkg: string; version?: string; subpath?: string } | undefined {
  let segments: string[];
  try {
    segments = raw
      .split("/")
      .filter((x) => x !== "")
      .map(decodeURIComponent);
  } catch {
    return undefined;
  }
  let scope = "";
  if (segments[0]?.startsWith("@")) {
    if (segments.length < 2 || segments[0].length < 2) return undefined;
    scope = `${segments.shift()}/`;
  }
  const nameVer = segments.shift();
  if (!nameVer) return undefined;
  const at = nameVer.indexOf("@");
  const name = at >= 0 ? nameVer.slice(0, at) : nameVer;
  if (
    !/^[a-z0-9][a-z0-9._~-]*$/i.test(name) ||
    (scope && !/^@[a-z0-9][a-z0-9._~-]*\/$/i.test(scope))
  )
    return undefined;
  if (segments.some((x) => x === ".." || x === ".")) return undefined;
  const version = at >= 0 ? nameVer.slice(at + 1) : undefined;
  return {
    pkg: scope + name,
    version: version || undefined,
    subpath: segments.join("/") || undefined,
  };
}

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function stubOf(ns: DurableObjectNamespace, name: string) {
  return ns.getByName ? ns.getByName(name) : ns.get(ns.idFromName(name));
}

/** Routes `/npm/*` to the module host of the profile. */
export async function handleCdn(request: Request, env: CdnEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const [, , profile] = url.pathname.split("/");
  if (!PROFILES.includes(profile as Profile))
    return text(`unknown profile "${profile}": use ${PROFILES.join(" or ")}\n`, 404);
  return stubOf(env.CDN, profile).fetch(request);
}

export class ModuleHost extends DurableObject<CdnEnv> {
  #server?: ModuleServer;

  server(profile: Profile, hasCss: boolean): ModuleServer {
    this.#server ??= newModuleServer({
      cache: new SqlFilesApi(this.ctx.storage.sql, "cdn"),
      sources: [npmRegistrySource({ fetch: registryFetch(this.env) })],
      target: profile === "node" ? "node" : "browser",
      basePath: `/npm/${profile}/`,
      cors: true,
      ...(hasCss ? {} : { css: passthroughCss }),
    });
    return this.#server;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , profile, ...rest] = url.pathname.split("/");
    await ensureLightningCss();
    const server = this.server(profile as Profile, hasLightningCss());
    const specPath = rest.join("/");
    if (!specPath)
      return text(
        `ESM CDN (${profile}): try /npm/${profile}/react or /npm/${profile}/lodash-es@4/merge\n`,
      );
    const spec = parseSpec(specPath);
    if (!spec) return text(`not a package spec: ${specPath}\n`, 400);
    try {
      if (url.searchParams.has("meta"))
        return json(await server.listPackageFiles(spec), { headers: CORS });
      if (url.searchParams.has("graph"))
        return json(await server.listResources(spec), { headers: CORS });
    } catch (e) {
      return text(`not found: ${(e as Error).message}\n`, 404);
    }
    if (spec.version && EXACT.test(spec.version) && spec.subpath) {
      const res = await server.fetch(request);
      if (res.status !== 200) return res;
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "public, max-age=31536000, immutable");
      return out;
    }
    try {
      const resolved = await server.resolve(spec);
      return new Response(null, {
        status: 302,
        headers: { ...CORS, location: resolved.url + url.search },
      });
    } catch (e) {
      return new Response(`not found: ${(e as Error).message}\n`, { status: 404, headers: CORS });
    }
  }
}
