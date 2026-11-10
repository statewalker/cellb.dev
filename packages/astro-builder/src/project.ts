/**
 * `buildAstroProject`: an Astro project's sources (a FilesApi holding `astro.config.mjs`,
 * `src/pages`, `public/`, `package.json`, `wrangler.jsonc`) built into what Astro's Cloudflare
 * build emits, as an input project for the platform's `buildProject`:
 *
 *   /wrangler.json      the project's wrangler config, with main → server/entry.mjs,
 *                       assets → client, nodejs_compat and the SESSION namespace Astro's
 *                       Cloudflare adapter adds
 *   /server/entry.mjs   ONE Worker module: Astro's App, the routes, every page
 *   /client/…           public/ and the client bundles (islands, renderers, scripts)
 *
 * The steps are cellb.dev's in-browser builder's (./build.ts, ./integrations.ts): the config and
 * its integrations are bundled and evaluated (a data: URL import, which workerd, celld, cellb and
 * browsers allow), then the server and client bundles are built with webrun-bundler and Astro's
 * compiler. It runs wherever esbuild runs: in a Durable Object (esbuild-wasm, the compiler as
 * WebAssembly), in a browser worker, on Node (native esbuild and compiler).
 */

import { listFiles, parseJsonc } from "@statewalker/cellb-platform-core/util";
import type { Esbuild, PackageStore } from "@statewalker/webrun-bundler";
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import { readFile, tryReadText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { AstroTransform } from "./astro-plugin.js";
import { buildAstroApp } from "./build.js";
import { type IntegrationResult, preloadVfs, runAstroConfig } from "./integrations.js";

export interface AstroSpec {
  /**
   * Packages build-time code reads by path, preloaded into the synchronous file system the
   * integrations see: `[name, importer?]`, the importer a package before it. `astro` is always
   * there. EmDash: `[["emdash"], ["@emdash-cms/admin", "emdash"]]`.
   */
  preload?: [string, string?][];
  /** `import.meta.url` of the bundled config (see `runAstroConfig`). */
  metaUrl?: string;
  /** Astro's session driver; default: Cloudflare KV on the `SESSION` binding, as the adapter's. */
  session?: false | { driver: string; options?: Record<string, unknown> };
}

export const ROOT = "/app";
const DEFAULT_SESSION = {
  driver: "unstorage/drivers/cloudflare-kv-binding",
  options: { binding: "SESSION" },
};

/**
 * The project seen at `/app` (the path the builder and the integrations' file system use), with
 * the files the builder writes (its entry modules) kept in memory: the sources stay untouched.
 */
export function appView(files: FilesApi): FilesApi {
  const upper = new MemFilesApi();
  const inner = (p: string) =>
    p === ROOT ? "/" : p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length) : undefined;
  const out = (info: FileInfo): FileInfo => ({
    ...info,
    path: `${ROOT}${info.path === "/" ? "" : info.path}`,
  });
  const view: FilesApi = {
    read(path, o) {
      return (async function* () {
        if (await upper.exists(path)) {
          yield* upper.read(path, o);
          return;
        }
        const p = inner(path);
        if (p) yield* files.read(p, o);
      })();
    },
    write: (path, c) => upper.write(path, c),
    mkdir: (path) => upper.mkdir(path),
    async *list(path, o) {
      const p = inner(path);
      const seen = new Set<string>();
      if (p) for await (const e of files.list(p, o)) seen.add(out(e).path) && (yield out(e));
      if (path === "/" && !seen.size) yield { kind: "directory", name: "app", path: ROOT };
      for await (const e of upper.list(path, o)) if (!seen.has(e.path)) yield e;
    },
    async stats(path) {
      const u = await upper.stats(path);
      if (u) return u;
      if (path === "/") return { kind: "directory" };
      const p = inner(path);
      return p ? files.stats(p) : undefined;
    },
    exists: async (path) => (await view.stats(path)) !== undefined,
    remove: (path) => upper.remove(path),
    move: (a, b) => upper.move(a, b),
    copy: (a, b) => upper.copy(a, b),
  };
  return view;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Evaluates an ES module's source in this realm: a data: URL import (no Blob URLs on servers). */
export const evaluateModule = (code: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ `data:text/javascript;base64,${toBase64(code)}`);

export async function isAstroProject(files: FilesApi): Promise<boolean> {
  for (const n of ["astro.config.mjs", "astro.config.js", "astro.config.ts"])
    if (await files.exists(`/${n}`)) return true;
  return false;
}

export async function buildAstroProject(opts: {
  files: FilesApi;
  esbuild: Esbuild;
  transform: AstroTransform;
  packages: PackageStore;
  spec?: AstroSpec;
  log?: (message: string) => void;
  /**
   * The bundled config, evaluated: for a realm that cannot evaluate code it is given (a Worker
   * Loader isolate has it among its modules). Default: bundled and evaluated here.
   */
  configModule?: () => Promise<Record<string, unknown>>;
}): Promise<{ files: Map<string, Uint8Array>; routes: number; ms: number }> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const spec = opts.spec ?? {};
  const app = appView(opts.files);
  const wranglerText =
    (await tryReadText(opts.files, "/wrangler.jsonc")) ??
    (await tryReadText(opts.files, "/wrangler.json"));
  const config = (wranglerText ? parseJsonc(wranglerText) : {}) as Record<string, unknown>;
  const session = spec.session === false ? undefined : (spec.session ?? DEFAULT_SESSION);

  let integration: IntegrationResult | undefined;
  let nodeMounts: Awaited<ReturnType<typeof preloadVfs>>["mounts"] | undefined;
  if (await isAstroProject(opts.files)) {
    const chain: [string, string?][] = [...(spec.preload ?? [])];
    if (!chain.some(([n]) => n === "astro")) chain.push(["astro"]);
    log(`preloading ${chain.map(([n]) => n).join(", ")} for build-time code`);
    const { vfs, mounts } = await preloadVfs(app, ROOT, opts.packages, chain);
    nodeMounts = mounts;
    log(`build-time file system: ${vfs.size} files; running astro.config and its integrations`);
    integration = await runAstroConfig({
      esbuild: opts.esbuild,
      files: app,
      root: ROOT,
      packages: opts.packages,
      vfs,
      log,
      session,
      metaUrl: spec.metaUrl,
      evaluate: evaluateModule,
      configModule: opts.configModule,
    });
    log(
      `integrations: ${integration.routes.length} routes, ${integration.middleware.length} middleware, ${integration.renderers.length} renderers, plugins ${integration.plugins.map((p) => p.name).join(", ") || "none"}`,
    );
  }

  // The project's own Worker entry (EmDash's: scheduled() for its cron, PluginBridge).
  const main = typeof config.main === "string" ? config.main.replace(/^\.?\//, "") : undefined;
  const built = await buildAstroApp({
    esbuild: opts.esbuild,
    transform: opts.transform,
    files: app,
    root: ROOT,
    packages: opts.packages,
    log,
    integration,
    nodeMounts,
    session,
    main: main && (await opts.files.exists(`/${main}`)) ? main : undefined,
  });
  log(
    `astro built in ${built.ms} ms: ${(built.code.length / 1e6).toFixed(2)} MB, ${built.routes.length} routes`,
  );

  // What Astro's Cloudflare build writes next to it.
  const enc = new TextEncoder();
  const out = new Map<string, Uint8Array>();
  const {
    $schema: _s,
    main: _m,
    build: _b,
    assets,
    ...rest
  } = config as Record<string, unknown> & {
    assets?: { binding?: string };
  };
  const flags = new Set([
    ...((rest.compatibility_flags as string[] | undefined) ?? []),
    "nodejs_compat",
  ]);
  const kv = [...((rest.kv_namespaces as { binding: string }[] | undefined) ?? [])];
  if (
    session &&
    session.options?.binding &&
    !kv.some((n) => n.binding === session.options?.binding)
  )
    kv.push({ binding: String(session.options.binding) });
  const wranglerJson = {
    name: "astro-app",
    compatibility_date: "2026-02-24",
    ...rest,
    compatibility_flags: [...flags],
    ...(kv.length ? { kv_namespaces: kv } : {}),
    main: "server/entry.mjs",
    assets: { binding: assets?.binding ?? "ASSETS", directory: "client" },
  };
  out.set("/wrangler.json", enc.encode(`${JSON.stringify(wranglerJson, null, 2)}\n`));
  out.set("/server/entry.mjs", enc.encode(built.code));
  for (const p of await listFiles(opts.files, "/public"))
    out.set(`/client${p.slice("/public".length)}`, await readFile(opts.files, p));
  for (const [url, bytes] of built.clientAssets) out.set(`/client${url}`, bytes);
  return { files: out, routes: built.routes.length, ms: Date.now() - started };
}
