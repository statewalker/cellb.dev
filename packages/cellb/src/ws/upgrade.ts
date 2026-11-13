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

/**
 * `req` with `extra` headers set on top of its own, as an own `headers` property (a standalone
 * `Headers`, which keeps the names a browser drops from Requests: `Cookie`, `Upgrade`, `Sec-*`).
 */
export function withHeaders<R extends Request>(req: R, extra: HeadersInit): R {
  const headers = new Headers(req.headers);
  for (const [k, v] of new Headers(extra)) headers.set(k, v);
  Object.defineProperty(req, "headers", { value: headers, configurable: true, enumerable: true });
  return req;
}

/**
 * Copies `Upgrade`, `Sec-WebSocket-*` and `Cookie` from `from` onto a rebuilt request (no-op if
 * none): a browser drops them from every `new Request()`.
 */
export function carryWebSocketHeaders<R extends Request>(from: Headers, to: R): R {
  const upgrade = from.get("Upgrade");
  const cookie = from.get("Cookie");
  if (cookie !== null && to.headers.get("Cookie") !== cookie) withHeaders(to, { cookie });
  if (!upgrade) return to;
  const extra: [string, string][] = [];
  for (const [k, v] of from) if (k !== "upgrade" && isWebSocketHeader(k)) extra.push([k, v]);
  return withUpgrade(to, upgrade, extra);
}

const HostRequest = globalThis.Request;

/**
 * `init` with `duplex: "half"` when its body is a stream: workerd takes a streamed request body
 * as it is, while Node's `Request` (undici) refuses one without that option.
 */
function streamingInit(init?: RequestInit): RequestInit | undefined {
  const body = init?.body as unknown;
  if (!body || (init as { duplex?: unknown }).duplex !== undefined) return init;
  // A Request (or another object) as init keeps its prototype getters (`method`, `headers`) only
  // as it is: a spread copies own properties alone.
  if (Object.getPrototypeOf(init) !== Object.prototype) return init;
  const streamed =
    body instanceof ReadableStream ||
    (typeof body === "object" &&
      typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function");
  return streamed ? ({ ...init, duplex: "half" } as RequestInit) : init;
}

/**
 * The `Request` global of Worker code. A browser drops `Upgrade`, `Sec-WebSocket-*` and `Cookie`
 * from every `new Request()`, so a Worker that copies an upgrade request (`new Request(req)`, as
 * partyserver does before it forwards a socket to its Durable Object) or a request with cookies
 * would lose them; this one carries them over, like the rest of the headers. Requests the host
 * makes are instances too.
 */
export class CellsRequest extends HostRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, streamingInit(init));
    // `init.headers` replaces the input's headers, as in `Request` itself.
    // Not a fresh `Headers` from a Request's own: a browser's would drop what it carries.
    const from =
      init?.headers !== undefined
        ? init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers)
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
