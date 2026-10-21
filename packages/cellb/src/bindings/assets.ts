import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Static assets as celld serves them (docs/services/static-assets.md), checked against
 * celld 0.6.2 by conformance/projects/assets-api:
 * GET/HEAD only; `run_worker_first`; `_redirects` first (301/302/303/307/308 → Location,
 * 200 → rewrite, `*` → `:splat`); `html_handling` auto-trailing-slash with 307 to canonical
 * paths; `not_found_handling` (with a Worker, only for navigation requests); strong
 * SHA-256 ETag, If-None-Match → 304, Range → 206/416, `_headers` rules,
 * `Cache-Control: public, max-age=0, must-revalidate` by default; unknown extension → no
 * Content-Type.
 */
export interface AssetsConfig {
  directory?: string;
  binding?: string;
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  not_found_handling?: "single-page-application" | "404-page" | "none";
  run_worker_first?: boolean | string[];
}

/** File path ("/about.html") → bytes. */
export type AssetFiles = Map<string, Uint8Array>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  wasm: "application/wasm",
  pdf: "application/pdf",
  woff2: "font/woff2",
  woff: "font/woff",
};

interface Redirect {
  from: RegExp;
  names: string[];
  to: string;
  status: number;
}

function globToRegExp(pattern: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const src = pattern
    .split(/(\*|:[A-Za-z_]\w*)/)
    .map((part) => {
      if (part === "*") {
        names.push("splat");
        return "(.*)";
      }
      if (part.startsWith(":")) {
        names.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { re: new RegExp(`^${src}$`), names };
}

function parseRedirects(text: string | undefined): Redirect[] {
  const out: Redirect[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [from, to, status] = t.split(/\s+/);
    const { re, names } = globToRegExp(from);
    out.push({ from: re, names, to, status: Number(status ?? 302) });
  }
  return out;
}

function parseHeaderRules(text: string | undefined): { re: RegExp; headers: [string, string][] }[] {
  const rules: { re: RegExp; headers: [string, string][] }[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ re: globToRegExp(line.trim()).re, headers: [] });
    else {
      const i = line.indexOf(":");
      if (i > 0 && rules.length)
        rules.at(-1)!.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

const decoder = new TextDecoder();

export function createAssets(files: AssetFiles, config: AssetsConfig, hasWorker: boolean) {
  const redirects = parseRedirects(
    files.has("/_redirects") ? decoder.decode(files.get("/_redirects")) : undefined,
  );
  const headerRules = parseHeaderRules(
    files.has("/_headers") ? decoder.decode(files.get("/_headers")) : undefined,
  );
  const etags = new Map<string, string>();
  const etagOf = (path: string) => {
    let e = etags.get(path);
    if (!e) {
      e = `"${bytesToHex(sha256(files.get(path)!))}"`;
      etags.set(path, e);
    }
    return e;
  };
  const exists = (p: string) => files.has(p) && p !== "/_headers" && p !== "/_redirects";

  const workerFirst = (path: string) => {
    const r = config.run_worker_first;
    if (r === true) return true;
    if (!Array.isArray(r)) return false;
    let hit = false;
    for (const p of r) {
      const neg = p.startsWith("!");
      if (globToRegExp(neg ? p.slice(1) : p).re.test(path)) hit = !neg;
    }
    return hit;
  };

  /** Resolves a URL path to a file, or a canonical redirect (auto-trailing-slash). */
  const lookup = (path: string): { file: string } | { redirect: string } | undefined => {
    const mode = config.html_handling ?? "auto-trailing-slash";
    if (mode === "none") return exists(path) ? { file: path } : undefined;
    if (path.endsWith("/index.html")) {
      if (exists(path)) return { redirect: path.slice(0, -"index.html".length) };
    } else if (path.endsWith(".html")) {
      if (exists(path)) return { redirect: path.slice(0, -".html".length) };
    }
    if (path.endsWith("/")) {
      // `/` and `/dir/` → index.html. (celld 0.6.2 serves only the root index here and
      // falls through for nested ones — a celld bug; we follow Cloudflare, see note 18.)
      return exists(`${path}index.html`) ? { file: `${path}index.html` } : undefined;
    }
    if (exists(path)) return { file: path };
    if (exists(`${path}.html`)) return { file: `${path}.html` };
    if (exists(`${path}/index.html`)) return { redirect: `${path}/` };
    return undefined;
  };

  const serve = (req: Request, file: string, status = 200): Response => {
    const bytes = files.get(file)!;
    const etag = etagOf(file);
    const headers = new Headers();
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    for (const rule of headerRules)
      if (rule.re.test(new URL(req.url).pathname))
        for (const [k, v] of rule.headers) headers.set(k, v);
    headers.set("etag", etag);
    if (req.headers.get("if-none-match") === etag) {
      headers.delete("cache-control");
      return new Response(null, { status: 304, headers });
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (range && status === 200) {
      const size = bytes.byteLength;
      let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] === "" ? size - 1 : range[2] === "" ? size - 1 : Number(range[2]);
      if (start >= size || start < 0 || start > end) {
        headers.set("content-range", `bytes */${size}`);
        headers.set("content-length", "0");
        headers.delete("cache-control");
        return new Response(null, { status: 416, headers });
      }
      end = Math.min(end, size - 1);
      start = Math.max(0, start);
      if (TYPES[ext]) headers.set("content-type", TYPES[ext]);
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
      headers.set("content-length", String(end - start + 1));
      headers.delete("cache-control");
      return new Response(
        req.method === "HEAD" ? null : (bytes.slice(start, end + 1) as BodyInit),
        { status: 206, headers },
      );
    }
    if (TYPES[ext]) headers.set("content-type", TYPES[ext]);
    if (!headers.has("cache-control"))
      headers.set("cache-control", "public, max-age=0, must-revalidate");
    headers.set("content-length", String(bytes.byteLength));
    return new Response(req.method === "HEAD" ? null : (bytes as BodyInit), { status, headers });
  };

  const redirectTo = (location: string, status: number) =>
    new Response(null, { status, headers: { location, "content-length": "0" } });

  /** The asset router. `undefined` = not an asset: hand the request to the Worker. */
  const route = (req: Request, viaBinding = false): Response | undefined => {
    if (req.method !== "GET" && req.method !== "HEAD") return undefined;
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (!viaBinding && hasWorker && workerFirst(path)) return undefined;
    for (const r of redirects) {
      const m = r.from.exec(path);
      if (!m) continue;
      let to = r.to;
      for (const [i, n] of r.names.entries()) to = to.replace(`:${n}`, m[i + 1]);
      if (r.status === 200) {
        path = to;
        break;
      }
      return redirectTo(to, r.status);
    }
    const hit = lookup(path);
    if (hit && "redirect" in hit) return redirectTo(`${hit.redirect}${url.search}`, 307);
    if (hit) return serve(req, hit.file);
    // Miss: not_found_handling (with a Worker, only for navigation requests).
    const nav = req.headers.get("sec-fetch-mode") === "navigate";
    if (!hasWorker || nav || viaBinding) {
      if (config.not_found_handling === "single-page-application" && exists("/index.html"))
        return serve(req, "/index.html");
      if (config.not_found_handling === "404-page") {
        for (
          let dir = path.slice(0, path.lastIndexOf("/") + 1);
          dir;
          dir = dir.slice(0, dir.lastIndexOf("/", dir.length - 2) + 1)
        ) {
          if (exists(`${dir}404.html`)) return serve(req, `${dir}404.html`, 404);
          if (dir === "/") break;
        }
      }
    }
    if (hasWorker && !viaBinding) return undefined;
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    route,
    /** The `env.ASSETS` binding. */
    binding: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        route(new Request(input, init), true)!,
    },
  };
}
