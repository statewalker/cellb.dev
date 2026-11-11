// The running app's client as static files: what a deployment serves as its assets.
//
// In the sandbox the client's modules are compiled on request (`/_modules/…`). A deployment has
// no module server, so the export asks the app's own site for every page, follows each page's
// module scripts and each module's imports, and keeps what the site answered: the same bytes the
// preview ran. Static hosts (Cloudflare's assets, celld, any CDN) pick the MIME type from the
// file's extension and browsers run a module script only with a JavaScript type, so a compiled
// module whose URL does not end in .js or .mjs (main.tsx, styles.css imported from a script) is
// saved as `<path>.js`, and the references to it are rewritten.

import { encode, MODULES_PREFIX, mimeOf, type ProjectFiles } from "./project";

export type SiteHandler = (request: Request) => Promise<Response>;

const ORIGIN = "http://app.local";
const JS_EXT = /\.m?js$/i;

/** Import specifiers in compiled ESM: static imports, re-exports, side-effect and dynamic imports. */
export function importsOf(code: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Local URLs in a page's src/href attributes. */
export function pageRefsOf(html: string): string[] {
  return [...html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

const pathOf = (url: URL) => decodeURIComponent(url.pathname);
const isModule = (path: string) => path.startsWith(MODULES_PREFIX);

/**
 * The client's files as a static site: pages as the site serves them (scripts pointed at
 * `_modules/`), other client files as they are, and every module the pages reach.
 */
export async function exportClient(
  site: SiteHandler,
  client: ProjectFiles,
  log: (text: string) => void = () => {},
): Promise<ProjectFiles> {
  const out: ProjectFiles = new Map();
  const pages = new Map<string, string>();
  const modules = new Map<string, { text: string; type: string; specs: Map<string, string> }>();
  const queue: string[] = [];
  const enqueue = (spec: string, base: string, from?: Map<string, string>) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(spec)) return; // other origins, data:, anchors
    const url = new URL(spec, `${ORIGIN}${base}`);
    const path = pathOf(url);
    if (!isModule(path)) return;
    from?.set(spec, path);
    if (!modules.has(path) && !queue.includes(path)) queue.push(path);
  };

  for (const [path, bytes] of client) {
    if (path === "/package.json") continue;
    if (!mimeOf(path).startsWith("text/html")) {
      out.set(path, bytes);
      continue;
    }
    const res = await site(new Request(`${ORIGIN}${path}`));
    if (!res.ok) throw new Error(`${path.slice(1)}: the site answered ${res.status}`);
    const html = await res.text();
    pages.set(path, html);
    for (const ref of pageRefsOf(html)) enqueue(ref, path);
  }

  while (queue.length) {
    const path = queue.shift() as string;
    const res = await site(new Request(`${ORIGIN}${path}`));
    if (!res.ok)
      throw new Error(
        `${path.slice(MODULES_PREFIX.length)} did not compile (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const specs = new Map<string, string>();
    modules.set(path, { text, type, specs });
    if (/javascript|ecmascript/i.test(type) || JS_EXT.test(path))
      for (const spec of importsOf(text)) enqueue(spec, path, specs);
  }

  // Module files keep their path unless a static host would give them a non-JavaScript type.
  const target = (path: string) => {
    const m = modules.get(path);
    if (!m) return path;
    const js = /javascript|ecmascript/i.test(m.type);
    return js && !JS_EXT.test(path) ? `${path}.js` : path;
  };
  const renamed = (spec: string, path: string) => {
    const next = target(path);
    if (next === path) return spec;
    const [bare, rest = ""] = spec.split(/(?=[?#])/);
    return `${bare}${next.slice(path.length)}${rest}`;
  };
  const rewrite = (text: string, specs: Map<string, string>) => {
    let s = text;
    for (const [spec, path] of specs) {
      const next = renamed(spec, path);
      if (next !== spec)
        s = s.split(`"${spec}"`).join(`"${next}"`).split(`'${spec}'`).join(`'${next}'`);
    }
    return s;
  };

  for (const [path, html] of pages) {
    const specs = new Map<string, string>();
    for (const ref of pageRefsOf(html)) enqueue(ref, path, specs);
    out.set(path, encode(rewrite(html, specs)));
  }
  for (const [path, m] of modules) out.set(target(path), encode(rewrite(m.text, m.specs)));
  log(`client exported: ${pages.size} page(s), ${modules.size} module(s)`);
  return out;
}
