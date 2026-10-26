import { deserializeError } from "@statewalker/webrun-streams";
import { toAnotherNode } from "../core/handles.js";
import type { DurableObjectId } from "../core/id.js";
import type { ObjectEndpoint } from "../core/namespace.js";
import type { ValueCodec } from "../ports.js";
import { carryWebSocketHeaders } from "../ws/upgrade.js";

/** Control headers that mark internal requests on a cells-http link (see cells-http.ts). */
export const H = {
  kind: "x-cellb", // "describe" | "fetch" | "rpc" | "error" (response)
  binding: "x-cellb-binding",
  target: "x-cellb-target", // "name:<n>" | "id:<hex>"
  method: "x-cellb-method",
  proto: "x-cellb-proto", // original scheme (the HTTP/1.1 wire drops it)
  ws: "x-cellb-ws", // request: id under which the caller awaits a WebSocket port
  wsAccepted: "x-cellb-ws-accepted", // response: the port was handed over (control channel)
  upgrade: "x-cellb-upgrade", // `Upgrade` is hop-by-hop: dropped by the HTTP/1.1 wire, carried here
  wsProtocol: "x-cellb-ws-protocol", // `Sec-WebSocket-Protocol` is forbidden in browser Requests
} as const;

export type Send = (req: Request) => Promise<Response>;

/** A `send` that carries the scheme and turns `x-cellb: error` responses back into exceptions. */
export function postVia(send: Send): Send {
  return async (req) => {
    const res = await send(withScheme(req));
    if (res.headers.get(H.kind) === "error") throw deserializeError(await res.json());
    return res;
  };
}

/** Stub endpoint whose object lives behind `post` (another worker, tab or peer). */
export function httpEndpoint(
  post: Send,
  codec: ValueCodec,
  binding: string,
  className: string,
  id: DurableObjectId,
): ObjectEndpoint {
  // By name when the id came from one (only idFromName() sets `name`): keeps ctx.id.name
  // on the far side, which derives the same id with the same namespace key.
  const target = id.name !== undefined ? `name:${id.name}` : `id:${id}`;
  const base = { [H.binding]: binding, [H.target]: target };
  return {
    // Not the caller's abort signal: an aborted caller does not cancel a local object's
    // fetch() either (the object answers, nobody reads), so neither does a remote one.
    fetch: (req) => post(addHeaders(req, { [H.kind]: "fetch", ...base }, { detach: true })),
    async call(method, args) {
      const res = await post(
        control("rpc", { ...base, [H.method]: method }, codec.encode(toAnotherNode(args))),
      );
      return codec.decode(new Uint8Array(await res.arrayBuffer()));
    },
  };
}

export function control(kind: string, headers: Record<string, string>, body?: Uint8Array): Request {
  return new Request("http://cellb.internal/", {
    method: body ? "POST" : "GET",
    headers: { [H.kind]: kind, ...headers },
    body: body as BodyInit | undefined,
  });
}

/**
 * Re-creates a request with extra headers, streaming its body through. The request itself is the
 * source, not `body: req.body`: Firefox has no `Request.body`, so that would drop the body there.
 */
function addHeaders(
  req: Request,
  extra: Record<string, string>,
  opts: { detach?: boolean } = {},
): Request {
  const headers = new Headers(req.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return keepUpgrade(req, new Request(req, opts.detach ? { headers, signal: null } : { headers }));
}

/** Browsers drop the forbidden `Upgrade` header from every rebuilt Request: carry it over. */
export function keepUpgrade(from: Request, to: Request): Request {
  return carryWebSocketHeaders(from.headers, to);
}

export function withScheme(req: Request): Request {
  return addHeaders(req, { [H.proto]: new URL(req.url).protocol.replace(":", "") });
}
