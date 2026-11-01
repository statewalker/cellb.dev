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
 * Multiplexed ports per link: one per exchange in flight (they are released when an exchange
 * ends, is cancelled or has no body: fetchClosing, servingClosing; p31-port-leak.test.ts).
 * `globalThis.__cellbMaxPorts` overrides it (tests that check nothing leaks set it low).
 */
const maxPorts = () => (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts ?? 4096;

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
    { mux: overPipe(port, { codec: structuredCodec, side: "responder", maxPorts: maxPorts() }) },
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
  // The same once the body is read to its end, or cancelled by its reader (then the exchange
  // is abandoned: the call's iterator is returned, which closes its port).
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const r = await reader.read();
      if (r.done) {
        ctl.close();
        drain();
      } else ctl.enqueue(r.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await (output as AsyncGenerator<unknown>).return?.(undefined).catch?.(() => {});
    },
  });
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
    mux: overPipe(port, { codec: structuredCodec, side: "initiator", maxPorts: maxPorts() }),
  });
  const remote = await remoteRuntime((req) => fetchClosing(call, req), opts);
  return Object.assign(remote, { close: async () => void (await close()) });
}

/** Serves any HTTP handler over a port (responder side of a link). */
export function serveHandlerOverPort(port: CellPort, handler: Send): Promise<() => Promise<void>> {
  return serve(
    { mux: overPipe(port, { codec: structuredCodec, side: "responder", maxPorts: maxPorts() }) },
    servingClosing(serveFetchOverDuplex(handler)),
  ) as Promise<() => Promise<void>>;
}

/** A `send` over a port (initiator side of a link); the scheme rides in a header. */
export async function linkOverPort(
  port: CellPort,
): Promise<{ send: Send; close(): Promise<void> }> {
  const { call, close } = await connect({
    mux: overPipe(port, { codec: structuredCodec, side: "initiator", maxPorts: maxPorts() }),
  });
  return {
    send: (req) => fetchClosing(call, withScheme(req)),
    close: async () => void (await close()),
  };
}
