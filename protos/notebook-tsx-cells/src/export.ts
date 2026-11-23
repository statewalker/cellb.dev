// PROTOTYPE (statewalker/statewalker-root#236). Writes what the module server would serve under
// `/_m/` as static files, so a built page runs from any static host (as a CI build needs):
// notebook-kit's runtime and stylesheet with their static imports, plus the built-in libraries the
// cells use (cellb.dev's `builtinClosure`), their `~esm/` redirects replaced by pinned URLs.
// The `?module` CSS rewrite follows cellb.dev's NotebookSite export.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { builtinClosure, type LocalBuiltinsServer, staticImports } from "../../../packages/notebooks/src/builtins.ts";

const TEXT = /\.(m?js|css)$/;

export async function exportModules(modules: LocalBuiltinsServer, outDir: string, roots: string[], runtimeUrl: string, used: Iterable<string>) {
  const get = (url: string) => modules.fetch(new Request(`http://local${url}`));
  const fetchText = async (url: string) => { const r = await get(url); return r.ok ? r.text() : undefined; };
  const files = new Map<string, Uint8Array>(); // path below outDir → bytes
  const queue = [...roots];
  while (queue.length) {
    const url = queue.shift()!;
    const path = url.split("?")[0]!.slice(1);
    if (files.has(path)) continue;
    const res = await get(url);
    if (!res.ok) throw new Error(`export: ${url} ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    files.set(path, bytes);
    if (TEXT.test(path)) for (const s of staticImports(new TextDecoder().decode(bytes)))
      if (s.startsWith("/") || s.startsWith(".")) queue.push(new URL(s.split("?")[0]!, `http://local${url}`).pathname);
  }
  const { urls, aliases } = await builtinClosure({
    runtimeUrl, used, fetchText, resolve: (url) => modules.resolveEsm(url), have: (url) => files.has(url.split("?")[0]!.slice(1)),
  });
  for (const url of urls) {
    const path = url.split("?")[0]!.slice(1);
    if (!files.has(path)) files.set(path, new Uint8Array(await (await get(url)).arrayBuffer()));
  }
  // A static host cannot redirect: name each pinned URL where the files named its `~esm/` alias.
  // `x.css?module` (a stylesheet served as a module) becomes `x.css.module.js`.
  const QUERY = /(["'])([^"'\s]+?)\?module\1/g;
  for (const [path, bytes] of [...files]) {
    if (!TEXT.test(path)) continue;
    let text = new TextDecoder().decode(bytes);
    for (const [from, to] of aliases) text = text.split(from).join(to);
    for (const [, , spec] of text.matchAll(QUERY)) {
      const url = new URL(spec, `http://local/${path}`);
      const target = `${url.pathname.slice(1)}.module.js`;
      if (!files.has(target)) files.set(target, new Uint8Array(await (await get(`${url.pathname}?module`)).arrayBuffer()));
    }
    files.set(path, new TextEncoder().encode(text.replace(QUERY, "$1$2.module.js$1")));
  }
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(outDir, path)), { recursive: true });
    await writeFile(join(outDir, path), bytes);
  }
  return files.size;
}
