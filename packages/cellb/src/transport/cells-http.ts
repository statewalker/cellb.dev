import { serializeError } from "@statewalker/webrun-streams";
import { DurableObjectNamespace, type DurableObjectStub } from "../core/namespace.js";
import type { CellRuntime } from "../core/runtime.js";
import type { ValueCodec } from "../ports.js";
import { v8Codec } from "../v8/codec.js";
import { type CfWebSocket, takeClientPort } from "../ws/server.js";
import { withUpgrade } from "../ws/upgrade.js";
import {
  control,
  H,
  httpEndpoint,
  keepUpgrade,
  postVia,
  type Send,
  withScheme,
} from "./cells-link.js";

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
const CT_VALUES = "application/x-cellb-values";

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
      throw new Error(`Unknown cellb request kind "${kind}"`);
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
