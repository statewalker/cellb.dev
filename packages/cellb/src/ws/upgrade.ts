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

const HostRequest = globalThis.Request;

/**
 * The `Request` global of Worker code. A browser drops `Upgrade` and `Sec-WebSocket-*` from every
 * `new Request()`, so a Worker that copies an upgrade request (`new Request(req)`, as partyserver
 * does before it forwards a socket to its Durable Object) would lose them; this one carries them
 * over, like the rest of the headers. Requests the host makes are instances too.
 */
export class CellsRequest extends HostRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    // `init.headers` replaces the input's headers, as in `Request` itself.
    const from =
      init?.headers !== undefined
        ? new Headers(init.headers)
        : input instanceof HostRequest
          ? input.headers
          : undefined;
    if (from) carryWebSocketHeaders(from, this);
  }

  override clone(): Request {
    return carryWebSocketHeaders(this.headers, super.clone());
  }

  static [Symbol.hasInstance](v: unknown): boolean {
    return v instanceof HostRequest;
  }
}
