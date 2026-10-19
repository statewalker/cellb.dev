/**
 * Browsers silently drop FORBIDDEN request headers from `new Request(...)`: `Upgrade`,
 * and every `Sec-*` header such as `Sec-WebSocket-Protocol` (Node/undici keeps them).
 * Cloudflare code reads `request.headers.get("Upgrade")` and the offered subprotocols,
 * so the runtime re-attaches them as an own `headers` property backed by a standalone
 * `Headers` object (guard "none" accepts any name).
 */
const isWebSocketHeader = (name: string) => name === "upgrade" || name.startsWith("sec-websocket-");

export function withUpgrade<R extends Request>(
  req: R,
  value = "websocket",
  extra?: HeadersInit,
): R {
  const headers = new Headers(req.headers);
  headers.set("Upgrade", value);
  for (const [k, v] of new Headers(extra)) headers.set(k, v);
  Object.defineProperty(req, "headers", { value: headers, configurable: true, enumerable: true });
  return req;
}

/** Copies `Upgrade` and `Sec-WebSocket-*` from `from` onto a rebuilt request (no-op if none). */
export function carryWebSocketHeaders<R extends Request>(from: Headers, to: R): R {
  const upgrade = from.get("Upgrade");
  if (!upgrade) return to;
  const extra: [string, string][] = [];
  for (const [k, v] of from) if (k !== "upgrade" && isWebSocketHeader(k)) extra.push([k, v]);
  return withUpgrade(to, upgrade, extra);
}
