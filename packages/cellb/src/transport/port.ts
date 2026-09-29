import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, overPipe, serve, structuredCodec } from "@statewalker/webrun-rpc";
import type { CellRuntime } from "../core/runtime.js";
import {
  type CellsHttpOptions,
  cellsHttpHandler,
  type RemoteRuntime,
  remoteRuntime,
  type Send,
  withScheme,
} from "./cells-http.js";

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
    { mux: overPipe(port, { codec: structuredCodec, side: "responder" }) },
    serveFetchOverDuplex(cellsHttpHandler(runtime, opts)),
  ) as Promise<() => Promise<void>>;
}

/** Front side (page, SW bridge, another tab): a RemoteRuntime over a port. */
export async function connectRuntime(
  port: CellPort,
  opts?: CellsHttpOptions,
): Promise<RemoteRuntime & { close(): Promise<void> }> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator" }),
  });
  const remote = await remoteRuntime((req) => fetchOverDuplex(call, req), opts);
  return Object.assign(remote, { close: async () => void (await close()) });
}

/** Serves any HTTP handler over a port (responder side of a link). */
export function serveHandlerOverPort(port: CellPort, handler: Send): Promise<() => Promise<void>> {
  return serve(
    { mux: overPipe(port, { codec: structuredCodec, side: "responder" }) },
    serveFetchOverDuplex(handler),
  ) as Promise<() => Promise<void>>;
}

/** A `send` over a port (initiator side of a link); the scheme rides in a header. */
export async function linkOverPort(
  port: CellPort,
): Promise<{ send: Send; close(): Promise<void> }> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator" }),
  });
  return {
    send: (req) => fetchOverDuplex(call, withScheme(req)),
    close: async () => void (await close()),
  };
}
