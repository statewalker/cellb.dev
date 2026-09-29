/**
 * `Upgrade` is a FORBIDDEN request header in browsers: `new Request(url, { headers:
 * { Upgrade: "websocket" } })` silently drops it (Node/undici keeps it). Cloudflare
 * code checks `request.headers.get("Upgrade")`, so the runtime re-attaches it as an
 * own `headers` property backed by a standalone `Headers` (guard "none" accepts it).
 */
export function withUpgrade<R extends Request>(req: R, value = "websocket"): R {
  if (req.headers.get("Upgrade") === value) return req;
  const headers = new Headers(req.headers);
  headers.set("Upgrade", value);
  Object.defineProperty(req, "headers", { value: headers, configurable: true, enumerable: true });
  return req;
}
