import { deserializeError, serializeError } from "@statewalker/webrun-streams";
import type { DurableObjectId } from "../core/id.js";
import {
  DurableObjectNamespace,
  type DurableObjectStub,
  type ObjectEndpoint,
} from "../core/namespace.js";
import type { CellRuntime } from "../core/runtime.js";
import type { ValueCodec } from "../ports.js";
import { v8Codec } from "../v8/codec.js";
import { type CfWebSocket, takeClientPort } from "../ws/server.js";
import { carryWebSocketHeaders, withUpgrade } from "../ws/upgrade.js";

/**
 * Everything a remote caller can do with a cell host is expressed as HTTP:
 * worker ingress, `stub.fetch()`, JS-RPC calls and the bindings descriptor.
 * The resulting `(Request) ⇒ Response` handler can then ride ANY webrun-wire
 * transport: a MessagePort (webrun-rpc), a WebSocket (webrun-streams-ws),
 * WebRTC / libp2p peers (httpeers) — via webrun-http-streams' Duplex seam.
 *
 * Control headers mark internal requests. TRUST MODEL: this handler is for an
 * internal link (page ⇄ worker, owner ⇄ forwarder). Public ingress must call
 * `runtime.fetch` directly, never this handler, or clients could address
 * objects without going through the Worker's own routing.
 */
export const H = {
  kind: "x-webrun-cells", // "describe" | "fetch" | "rpc" | "error" (response)
  binding: "x-webrun-cells-binding",
  target: "x-webrun-cells-target", // "name:<n>" | "id:<hex>"
  method: "x-webrun-cells-method",
  proto: "x-webrun-cells-proto", // original scheme (the HTTP/1.1 wire drops it)
  ws: "x-webrun-cells-ws", // request: id under which the caller awaits a WebSocket port
  wsAccepted: "x-webrun-cells-ws-accepted", // response: the port was handed over (control channel)
  upgrade: "x-webrun-cells-upgrade", // `Upgrade` is hop-by-hop: dropped by the HTTP/1.1 wire, carried here
  wsProtocol: "x-webrun-cells-ws-protocol", // `Sec-WebSocket-Protocol` is forbidden in browser Requests
} as const;

const CT_VALUES = "application/x-webrun-cells-values";

export interface CellsHttpOptions {
  codec?: ValueCodec;
  /**
   * A stub.fetch answered 101 with a WebSocket: hand the client end's port to the
   * caller out of band (the HTTP link cannot carry ports). Without it, WebSocket
   * upgrades cannot cross this link.
   */
  onUpgrade?: (id: string, port: MessagePort, protocol?: string) => void;
}

/** Server side: exposes a runtime as one HTTP handler. */
export function errorResponse(e: unknown, status = 500): Response {
  return Response.json(serializeError(e), { status, headers: { [H.kind]: "error" } });
}

export function cellsHttpHandler(
  runtime: CellRuntime,
  opts: CellsHttpOptions = {},
): (req: Request) => Promise<Response> {
  const codec = opts.codec ?? v8Codec; // the runtime's default: V8 serialization
  return async (incoming) => {
    const req = restoreScheme(incoming);
    const kind = req.headers.get(H.kind);
    if (!kind) return runtime.fetch(stripControl(req));
    try {
      if (kind === "describe")
        return Response.json({
          bindings: runtime.durableObjectBindings,
          // The far side derives the same ids only with the same namespace keys.
          keys: Object.fromEntries(
            Object.keys(runtime.durableObjectBindings).map((b) => [
              b,
              (runtime.env[b] as { namespaceKey?: string }).namespaceKey,
            ]),
          ),
        });
      const stub = stubOf(
        runtime,
        req.headers.get(H.binding) ?? "",
        req.headers.get(H.target) ?? "",
      );
      if (kind === "fetch") {
        const wsId = req.headers.get(H.ws);
        let inner = stripControl(req);
        const upgrade = req.headers.get(H.upgrade);
        if (upgrade) {
          const offered = req.headers.get(H.wsProtocol);
          inner = withUpgrade(
            inner,
            upgrade,
            offered ? { "Sec-WebSocket-Protocol": offered } : undefined,
          );
        }
        const res = (await stub.fetch(inner)) as Response & { webSocket?: CfWebSocket | null };
        if (res.status !== 101 || !res.webSocket) return res;
        if (!wsId || !opts.onUpgrade)
          throw new Error("WebSocket upgrade cannot cross this link (no control channel)");
        const protocol = res.headers.get("Sec-WebSocket-Protocol") ?? undefined;
        opts.onUpgrade(wsId, takeClientPort(res.webSocket), protocol);
        return new Response(null, {
          status: 200,
          headers: {
            [H.wsAccepted]: wsId,
            ...(protocol ? { "Sec-WebSocket-Protocol": protocol } : {}),
          },
        });
      }
      if (kind === "rpc") {
        const args = codec.decode(new Uint8Array(await req.arrayBuffer())) as unknown[];
        const result = await stub[req.headers.get(H.method) ?? ""](...args);
        return new Response(codec.encode(result) as BodyInit, {
          headers: { "content-type": CT_VALUES },
        });
      }
      throw new Error(`Unknown webrun-cells request kind "${kind}"`);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function stubOf(runtime: CellRuntime, binding: string, target: string): DurableObjectStub {
  const ns = runtime.env[binding];
  if (!(ns instanceof DurableObjectNamespace))
    throw new Error(`Unknown Durable Object binding "${binding}"`);
  if (target.startsWith("name:")) return ns.getByName(target.slice(5));
  if (target.startsWith("id:")) return ns.get(ns.idFromString(target.slice(3)));
  throw new Error(`Invalid Durable Object target "${target}"`);
}

export type Send = (req: Request) => Promise<Response>;

export interface RemoteRuntime {
  /** Ingress into the remote Worker's default fetch handler. */
  fetch(req: Request): Promise<Response>;
  /** Namespaces whose stubs send HTTP over the link (idFromName computed locally). */
  readonly env: Record<string, DurableObjectNamespace>;
}

/** Client side over any `send` (fetchOverDuplex over a port / WebSocket / peer, or the handler itself). */
export async function remoteRuntime(
  send: Send,
  opts: CellsHttpOptions = {},
): Promise<RemoteRuntime> {
  const codec = opts.codec ?? v8Codec; // the runtime's default: V8 serialization
  const post = postVia(send);
  const described = await post(control("describe", {}));
  const { bindings, keys } = (await described.json()) as {
    bindings: Record<string, string>;
    keys?: Record<string, string>;
  };
  const env: Record<string, DurableObjectNamespace> = {};
  for (const [binding, className] of Object.entries(bindings))
    env[binding] = new DurableObjectNamespace(
      keys?.[binding] ?? className,
      (id) => () => httpEndpoint(post, codec, binding, className, id),
    );
  return { env, fetch: (req) => send(withScheme(req)) };
}

/** A `send` that carries the scheme and turns `x-webrun-cells: error` responses back into exceptions. */
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
    fetch: (req) => post(addHeaders(req, { [H.kind]: "fetch", ...base })),
    async call(method, args) {
      const res = await post(control("rpc", { ...base, [H.method]: method }, codec.encode(args)));
      return codec.decode(new Uint8Array(await res.arrayBuffer()));
    },
  };
}

function control(kind: string, headers: Record<string, string>, body?: Uint8Array): Request {
  return new Request("http://webrun-cells.internal/", {
    method: body ? "POST" : "GET",
    headers: { [H.kind]: kind, ...headers },
    body: body as BodyInit | undefined,
  });
}

/** Re-creates a request with extra headers, streaming its body through. */
function addHeaders(req: Request, extra: Record<string, string>): Request {
  const headers = new Headers(req.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return keepUpgrade(
    req,
    new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
      duplex: "half",
    } as RequestInit),
  );
}

/** Browsers drop the forbidden `Upgrade` header from every rebuilt Request: carry it over. */
function keepUpgrade(from: Request, to: Request): Request {
  return carryWebSocketHeaders(from.headers, to);
}

export function withScheme(req: Request): Request {
  return addHeaders(req, { [H.proto]: new URL(req.url).protocol.replace(":", "") });
}

function restoreScheme(req: Request): Request {
  const proto = req.headers.get(H.proto);
  if (!proto) return req;
  const url = new URL(req.url);
  if (url.protocol === `${proto}:`) return req;
  url.protocol = `${proto}:`;
  return keepUpgrade(
    req,
    new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
      duplex: "half",
    } as RequestInit),
  );
}

export function stripControl(req: Request): Request {
  const headers = new Headers(req.headers);
  let changed = false;
  for (const h of Object.values(H)) if (headers.has(h)) headers.delete(h), (changed = true);
  if (!changed) return req;
  return keepUpgrade(
    req,
    new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
      duplex: "half",
    } as RequestInit),
  );
}
