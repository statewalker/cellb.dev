/**
 * Cookies for Workers served through a ServiceWorker. A browser hands a ServiceWorker no
 * `Cookie` header and ignores `Set-Cookie` on the responses it builds, so the router does what
 * the browser's network stack would: it sends the page's cookies to the Worker under
 * `x-cellb-cookie` (an ingress that carries it gets the Worker's `Set-Cookie` values back under
 * `x-cellb-set-cookie`, cells-http.ts), and stores those through the Cookie Store API.
 *
 * What differs from a server's cookies: they are written by script, so `HttpOnly` cannot be set
 * and they are readable by the page's own scripts; `Domain` is ignored (the origin's host); and
 * every cookie is stored with `Path=/` and sent with every request. Chromium lets a
 * ServiceWorker read cookies only for its default URL (`getAll({ url })` throws "URL must be
 * within Service Worker scope" for any URL), so a cookie scoped to `/_emdash/` could not be read
 * back at all.
 */
import { H } from "../transport/cells-link.js";

interface CookieStoreLike {
  getAll(options?: { url?: string }): Promise<{ name: string; value: string }[]>;
  set(options: {
    name: string;
    value: string;
    path?: string;
    expires?: number | null;
    sameSite?: "strict" | "lax" | "none";
    partitioned?: boolean;
  }): Promise<void>;
  delete(options: { name: string; path?: string }): Promise<void>;
}

const storeOf = (scope: unknown): CookieStoreLike | undefined =>
  (scope as { cookieStore?: CookieStoreLike }).cookieStore;

/** Headers for an ingress request: the request's own, plus the cookies its URL would carry. */
export async function withPageCookies(scope: unknown, req: Request): Promise<Headers> {
  const headers = new Headers(req.headers);
  const store = storeOf(scope);
  if (!store) return headers; // no Cookie Store API: no cookies either way
  const cookies = await store.getAll().catch(() => []);
  headers.set(H.cookie, cookies.map((c) => `${c.name}=${c.value}`).join("; "));
  return headers;
}

/** One `Set-Cookie` value as Cookie Store options; `expires: 0` deletes. */
export function parseSetCookie(value: string, now = Date.now()) {
  const [pair, ...attrs] = value.split(";");
  const eq = pair.indexOf("=");
  const cookie: {
    name: string;
    value: string;
    path?: string;
    expires?: number;
    sameSite?: "strict" | "lax" | "none";
  } = {
    name: (eq < 0 ? "" : pair.slice(0, eq)).trim(),
    value: (eq < 0 ? pair : pair.slice(eq + 1)).trim(),
  };
  let maxAge: number | undefined;
  for (const attr of attrs) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "path") cookie.path = val || "/";
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t;
    } else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
    else if (key === "samesite") {
      const s = val.toLowerCase();
      if (s === "strict" || s === "lax" || s === "none") cookie.sameSite = s;
    }
  }
  // Max-Age wins over Expires (RFC 6265); zero or less deletes.
  if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  return cookie;
}

/** Stores the Worker's tunneled Set-Cookie values and returns the response without them. */
export async function applyWorkerCookies(scope: unknown, res: Response): Promise<Response> {
  const tunneled = res.headers.get(H.setCookie);
  if (tunneled === null) return res;
  const store = storeOf(scope);
  for (const raw of tunneled.split(",").filter(Boolean)) {
    const c = parseSetCookie(decodeURIComponent(raw));
    if (!c.name || !store) continue;
    try {
      if (c.expires !== undefined && c.expires <= Date.now())
        await store.delete({ name: c.name, path: "/" });
      else
        await store.set({
          name: c.name,
          value: c.value,
          path: "/",
          expires: c.expires ?? null,
          sameSite: c.sameSite ?? "lax",
        });
    } catch (err) {
      console.warn(`cellb: cookie ${c.name} not stored: ${(err as Error)?.message ?? err}`);
    }
  }
  const headers = new Headers(res.headers);
  headers.delete(H.setCookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
