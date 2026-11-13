/**
 * `?next=`, the path of the site a visit asked for (the ServiceWorker's redirect to the
 * chooser), as a link target: only a path of this origin, outside the host pages. Parsed as
 * the browser would (it reads `\` as `/` and drops tabs and newlines: `/\evil.com` and
 * `/%09/evil.com` are other origins), never checked by its prefix.
 */
export function nextPath(search = location.search): string | undefined {
  const next = new URLSearchParams(search).get("next");
  if (!next?.startsWith("/")) return undefined;
  try {
    const u = new URL(next, location.origin);
    if (u.origin !== location.origin || u.pathname.startsWith("/__cellb/")) return undefined;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return undefined;
  }
}
