/**
 * A static export of a running site: pages are crawled from `start` through same-origin links
 * (`href`, `src`); the modules the pages import at run time are not crawled (they are reached
 * from JavaScript), they are the materialized dependency closure the caller adds beside the pages.
 * A page `/a/b` is saved as `a/b/index.html`, any other response under its own path.
 */
export async function crawlPages(
  fetch: (request: Request) => Promise<Response>,
  opts: { origin?: string; start?: string; skip?: RegExp; limit?: number } = {},
): Promise<Map<string, Uint8Array>> {
  const origin = opts.origin ?? "http://localhost";
  const queue = [opts.start ?? "/"];
  const seen = new Set(queue);
  const out = new Map<string, Uint8Array>();
  while (queue.length && out.size < (opts.limit ?? 500)) {
    const path = queue.shift() as string;
    const res = await fetch(new Request(origin + path));
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const html = (res.headers.get("content-type") ?? "").includes("text/html");
    out.set(
      html ? `${path.replace(/\/$/, "")}/index.html`.replace(/^\//, "") : path.slice(1),
      bytes,
    );
    if (!html) continue;
    for (const [, url] of new TextDecoder().decode(bytes).matchAll(/(?:href|src)="([^"#]+)/g)) {
      const u = new URL(url, origin + path);
      if (u.origin !== origin || opts.skip?.test(u.pathname) || seen.has(u.pathname)) continue;
      seen.add(u.pathname);
      queue.push(u.pathname);
    }
  }
  return out;
}
