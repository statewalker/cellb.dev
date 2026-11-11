/**
 * notebook-kit's built-ins without a CDN.
 *
 * notebook-kit's stdlib loads its libraries from esm.sh: `stdlib/recommendedLibraries.js` has one
 * line per name (`export const Plot = () => import("https://esm.sh/@observablehq/plot")`), and
 * `inputs.js`, `tex.js`, `dot.js`, `duckdb.js`… import from it too. A page that uses `Inputs` or
 * `Plot` therefore needs esm.sh at run time, hosted or exported.
 *
 * `withLocalBuiltins` wraps a site's module server so that it names its own URLs instead, lazily:
 *
 * - in the JS and CSS it serves, `https://esm.sh/<rest>` becomes `<base>~esm/<rest>`, a string
 *   replacement that resolves nothing (`recommendedLibraries.js` names fifteen libraries, and
 *   resolving `duckdb-wasm` or `echarts` for every page would download them for nothing);
 * - a request for `<base>~esm/<pkg>[@v][/path]` resolves that package like any `npm:` import (an
 *   unversioned URL takes the latest version, as on esm.sh) and redirects to its pinned URL, so a
 *   module's own relative imports resolve against the package. A package the registry does not
 *   have redirects to esm.sh, as before.
 *
 * `builtinClosure` is the export's half: the files the libraries a site's cells use need, found
 * from the cells' free variables and the modules' static imports, with the `~esm/` URLs they go
 * through, which the export replaces by the pinned ones (a static server cannot redirect).
 */
import type { ModuleRef, ModuleServer } from "@statewalker/webrun-modules";

/** `https://esm.sh/` + package (scoped or not), optional `@version`, optional `/path`, optional `?query`. */
const ESM_SH = /https:\/\/esm\.sh\/([^"'`\s)]+)/g;
/** `<pkg>[@version][/path][?query]` after `esm.sh/` or `~esm/`. */
const SPEC = /^((?:@[^/@?]+\/)?[^/@?]+)(?:@([^/?]+))?(\/[^?]*)?(\?.*)?$/;

const TEXT_TYPES = /javascript|ecmascript|text\/css/;

/** The package root (`<base><pkg>@<version>`) of a URL the module server resolved. */
function packageRoot(url: string, pkg: string): string | undefined {
  const at = url.indexOf(`${pkg}@`);
  if (at < 0) return undefined;
  const end = url.indexOf("/", at + pkg.length + 1);
  return end < 0 ? url : url.slice(0, end);
}

export interface LocalBuiltinsServer extends ModuleServer {
  /** The pinned module URL behind a `<base>~esm/…` URL, or `undefined` when there is none. */
  resolveEsm(url: string): Promise<string | undefined>;
}

/** A module server whose JS and CSS name the site's own modules where they named esm.sh. */
export function withLocalBuiltins(server: ModuleServer, basePath: string): LocalBuiltinsServer {
  const esmBase = `${basePath}~esm/`;
  const resolved = new Map<string, Promise<string | undefined>>();

  /** `<pkg>[@v][/path][?query]` → the pinned URL, resolving the package once. */
  const resolveSpec = (spec: string) => {
    let p = resolved.get(spec);
    if (!p) {
      p = (async () => {
        const m = SPEC.exec(spec);
        if (!m) return undefined;
        const [, pkg = "", version, path, query = ""] = m;
        const ref: ModuleRef = version ? { pkg, version } : { pkg };
        // A file of the package (`/dist/index.css`, `/dist/x.wasm`, `/x.worker.js`): its path in
        // the package. Any other path is a subpath export (`react-dom/client`).
        if (path && /\.[a-z0-9]+$/i.test(path)) {
          const root = packageRoot((await server.resolve(ref)).url, pkg);
          // `?raw` (a classic worker script, untransformed) is the module server's too.
          return root && `${root}${path}${query === "?raw" ? "?raw" : ""}`;
        }
        const sub = path?.slice(1);
        return (await server.resolve(sub ? { ...ref, subpath: sub } : ref)).url;
      })().catch(() => undefined);
      resolved.set(spec, p);
    }
    return p;
  };

  const resolveEsm = (url: string) =>
    url.startsWith(esmBase) ? resolveSpec(url.slice(esmBase.length)) : Promise.resolve(undefined);

  return {
    resolve: (ref, importer) => server.resolve(ref, importer),
    prime: (entry) => server.prime(entry),
    listResources: (entry) => server.listResources(entry),
    listPackageFiles: (ref) => server.listPackageFiles(ref),
    get lock() {
      return server.lock;
    },
    resolveEsm,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(esmBase)) {
        const spec = url.pathname.slice(esmBase.length) + url.search;
        const target = await resolveSpec(spec);
        return new Response(null, {
          status: 302,
          headers: { location: target ?? `https://esm.sh/${spec}` },
        });
      }
      const res = await server.fetch(request);
      if (!res.ok || !TEXT_TYPES.test(res.headers.get("content-type") ?? "")) return res;
      const text = await res.text();
      if (!text.includes("https://esm.sh/")) return new Response(text, res);
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      headers.delete("etag");
      // esm.sh's own build options (`?target=…`) mean nothing here; `?raw` is kept.
      const local = text.replace(ESM_SH, (_, rest: string) => {
        const [spec = "", query = ""] = rest.split("?");
        return `${esmBase}${spec}${query === "raw" ? "?raw" : ""}`;
      });
      return new Response(local, { status: res.status, headers });
    },
  };
}

/** The specifiers a module imports statically (`import … from`, `export … from`, `import "…"`, CSS `@import`). */
export function staticImports(source: string): string[] {
  const out = new Set<string>();
  for (const re of [
    /(?:^|[;}\s])(?:import|export)\s[^;"'`]*?\sfrom\s*["']([^"']+)["']/g,
    /(?:^|[;}\s])import\s*["']([^"']+)["']/g,
    /@import\s+(?:url\()?["']([^"']+)["']/g,
  ])
    for (const [, spec] of source.matchAll(re)) out.add(spec);
  return [...out];
}

/** `export const NAME = () => import("URL")…` of `recommendedLibraries.js`: name → URL. */
export function recommendedLibraries(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, url] of source.matchAll(
    /export\s+const\s+([\w$]+)\s*=\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/g,
  ))
    out.set(name, url);
  return out;
}

/**
 * The module URLs the libraries in `used` need, starting from notebook-kit's
 * `recommendedLibraries.js` (its URL in the site, `runtimeUrl`'s stdlib) and following static
 * imports. `resolve` maps a URL that redirects (`~esm/…`) to its target, `aliases` records each.
 */
export async function builtinClosure(opts: {
  runtimeUrl: string;
  used: Iterable<string>;
  fetchText: (url: string) => Promise<string | undefined>;
  /** The target of a URL that redirects, else `undefined`. */
  resolve?: (url: string) => Promise<string | undefined>;
  /** Module URLs already in the export: not listed again. */
  have: (url: string) => boolean;
}): Promise<{ urls: string[]; names: string[]; aliases: Map<string, string> }> {
  const libsUrl = new URL("stdlib/recommendedLibraries.js", `http://local${opts.runtimeUrl}`);
  const aliases = new Map<string, string>();
  const source = await opts.fetchText(libsUrl.pathname);
  if (source === undefined) return { urls: [], names: [], aliases };
  const libraries = recommendedLibraries(source);
  const names = [...new Set(opts.used)].filter((n) => libraries.has(n)).sort();
  const queue = names.map((n) => libraries.get(n) as string).map((u) => [u, libsUrl.href] as const);
  const seen = new Set<string>();
  const urls: string[] = [];
  while (queue.length) {
    const [spec, base] = queue.shift() as (typeof queue)[number];
    if (!spec.startsWith("/") && !spec.startsWith(".")) continue; // still a CDN URL
    const u = new URL(spec, base);
    let url = u.pathname + (u.search === "?raw" ? "?raw" : "");
    const target = await opts.resolve?.(url);
    if (target) {
      aliases.set(url, target);
      url = target;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    // A classic worker script (`?raw`) comes from an explicit line and has no imports to follow.
    if (url.endsWith("?raw")) {
      if (!opts.have(url)) urls.push(url);
      continue;
    }
    // Listed only once it loads: `staticImports` reads source text, and a match inside a comment
    // or a string must not make the export fail on a file that does not exist.
    const text = await opts.fetchText(url);
    if (text === undefined) continue;
    if (!opts.have(url)) urls.push(url);
    for (const s of staticImports(text)) queue.push([s, `http://local${url}`]);
  }
  return { urls, names, aliases };
}
