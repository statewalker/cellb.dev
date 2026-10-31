import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";
import type { CellRuntime } from "../core/runtime.js";
import {
  type CellsHttpOptions,
  cellsHttpHandler,
  type RemoteRuntime,
  remoteRuntime,
} from "./cells-http.js";
import { type Send, withScheme } from "./cells-link.js";

/**
 * Multiplexed ports per link. Ports of GET exchanges are not all released by webrun-rpc
 * 0.4.3 yet (a leak still under investigation: about one per request on a long-lived link),
 * and its default (1024) refused calls after ~1000 requests, which a build makes in minutes.
 */
const MAX_PORTS = 1 << 20;

/**
 * A DEDICATED message pipe (MessagePort, or a worker_threads port). Don't pass a
 * Worker object that also carries other messages — transfer a MessageChannel port.
 */
export type CellPort = Parameters<typeof overPipe>[0];

/**
 * Cell-host side: serves the runtime's HTTP surface over a port with
 * webrun-rpc (mux + backpressure) and webrun-http-streams (HTTP/1.1 on the
 * Duplex, streaming bodies). Resolves to an async disposer.
 */
export function serveRuntime(
  port: CellPort,
  runtime: CellRuntime,
  opts?: CellsHttpOptions,
): Promise<() => Promise<void>> {
  return serve(
    { mux: overPipe(port, { codec: structuredCodec, side: "responder", maxPorts: MAX_PORTS }) },
    servingClosing(serveFetchOverDuplex(cellsHttpHandler(runtime, opts))),
  ) as Promise<() => Promise<void>>;
}

/**
 * fetchOverDuplex, draining the call's output when the response has no body (HEAD, 204, 304…):
 * webrun-http-streams then returns without reading the exchange to its end, and the call's
 * multiplexed port stayed open, one per such request, until `maxPorts` (1024) refused calls.
 */
type Call = Parameters<typeof fetchOverDuplex>[0];
async function fetchClosing(call: Call, req: Request): Promise<Response> {
  let output: AsyncIterable<unknown> | undefined;
  const res = await fetchOverDuplex(
    ((input: unknown) => {
      output = (call as (i: unknown) => AsyncIterable<unknown>)(input);
      return output;
    }) as Call,
    req,
  );
  const drain = () =>
    void (async () => {
      try {
        for await (const _ of output as AsyncIterable<unknown>);
      } catch {}
    })();
  if (!output) return res;
  if (res.body === null) {
    drain();
    return res;
  }
  // The same once a body has been read to its end: the codec stops at the body's end marker.
  const body = res.body.pipeThrough(new TransformStream({ flush: drain }));
  return Object.assign(new Response(body, res), {
    webSocket: (res as { webSocket?: unknown }).webSocket ?? null,
  });
}

/**
 * serveFetchOverDuplex, draining what is left of the request side once the response is out:
 * a handler that does not read the request body (a GET) left the exchange half open, and its
 * multiplexed port open, one per request.
 */
type Duplex = ReturnType<typeof serveFetchOverDuplex>;
function servingClosing(duplex: Duplex): Duplex {
  return async function* (input: AsyncIterable<unknown>) {
    const it = input[Symbol.asyncIterator]();
    const rest: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => it };
    try {
      yield* (duplex as (i: AsyncIterable<unknown>) => AsyncIterable<unknown>)(rest);
    } finally {
      void (async () => {
        try {
          for (let r = await it.next(); !r.done; r = await it.next());
        } catch {}
      })();
    }
  } as unknown as Duplex;
}

/** Front side (page, SW bridge, another tab): a RemoteRuntime over a port. */
export async function connectRuntime(
  port: CellPort,
  opts?: CellsHttpOptions,
): Promise<RemoteRuntime & { close(): Promise<void> }> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator", maxPorts: MAX_PORTS }),
  });
  const remote = await remoteRuntime((req) => fetchClosing(call, req), opts);
  return Object.assign(remote, { close: async () => void (await close()) });
}

/** Serves any HTTP handler over a port (responder side of a link). */
export function serveHandlerOverPort(port: CellPort, handler: Send): Promise<() => Promise<void>> {
  return serve(
    { mux: overPipe(port, { codec: structuredCodec, side: "responder", maxPorts: MAX_PORTS }) },
    servingClosing(serveFetchOverDuplex(handler)),
  ) as Promise<() => Promise<void>>;
}

/** A `send` over a port (initiator side of a link); the scheme rides in a header. */
export async function linkOverPort(
  port: CellPort,
): Promise<{ send: Send; close(): Promise<void> }> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator", maxPorts: MAX_PORTS }),
  });
  return {
    send: (req) => fetchClosing(call, withScheme(req)),
    close: async () => void (await close()),
  };
}
