import { connectHttpLink, serveHttpLink } from "@statewalker/webrun-http-browser/sw";
import type { overPipe } from "@statewalker/webrun-rpc";
import type { CellRuntime } from "../core/runtime.js";
import {
  type CellsHttpOptions,
  cellsHttpHandler,
  type RemoteRuntime,
  remoteRuntime,
} from "./cells-http.js";
import { type Send, withScheme } from "./cells-link.js";

/**
 * Multiplexed ports per link: one per exchange in flight, given back when the exchange ends
 * (p31-port-leak.test.ts). 4096 per link, cellb's ceiling before the links were the package's (its
 * default is 1024): a streaming response holds its port for its whole life.
 * `globalThis.__cellbMaxPorts` overrides it: tests that check nothing leaks set it low.
 *
 * Since webrun-http-browser 0.12 a body's chunks are pipelined under the link's flow-control
 * window (256 KiB by default) instead of going one confirmed chunk at a time: a reader that stops
 * holds about one window of its body, so the bound is about `maxPorts` windows per link.
 */
const maxPorts = () => (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts ?? 4096;

/**
 * A DEDICATED message pipe (MessagePort, or a worker_threads port). Don't pass a
 * Worker object that also carries other messages — transfer a MessageChannel port.
 */
export type CellPort = Parameters<typeof overPipe>[0];

/**
 * The links are webrun-http-browser's (`connectHttpLink` / `serveHttpLink`): HTTP/1.1 with
 * streaming bodies over webrun-rpc calls, one multiplexed port per exchange. They take a
 * MessagePort; a worker_threads port has the same `postMessage` / `addEventListener` surface.
 */
const asPort = (port: CellPort) => port as unknown as MessagePort;

/**
 * Cell-host side: serves the runtime's HTTP surface over a port. Resolves to an async
 * disposer.
 */
export function serveRuntime(
  port: CellPort,
  runtime: CellRuntime,
  opts?: CellsHttpOptions,
): Promise<() => Promise<void>> {
  return serveHttpLink(asPort(port), cellsHttpHandler(runtime, opts), { maxPorts: maxPorts() });
}

/** Front side (page, SW bridge, another tab): a RemoteRuntime over a port. */
export async function connectRuntime(
  port: CellPort,
  opts?: CellsHttpOptions,
): Promise<RemoteRuntime & { close(): Promise<void> }> {
  const link = await connectHttpLink(asPort(port), { maxPorts: maxPorts() });
  const remote = await remoteRuntime((req) => link.send(req), opts);
  return Object.assign(remote, { close: () => link.close() });
}

/** Serves any HTTP handler over a port (responder side of a link). */
export function serveHandlerOverPort(port: CellPort, handler: Send): Promise<() => Promise<void>> {
  return serveHttpLink(asPort(port), handler, { maxPorts: maxPorts() });
}

/** A `send` over a port (initiator side of a link); the scheme rides in a header. */
export async function linkOverPort(
  port: CellPort,
): Promise<{ send: Send; close(): Promise<void> }> {
  const link = await connectHttpLink(asPort(port), { maxPorts: maxPorts() });
  return {
    send: (req) => link.send(withScheme(req)),
    close: () => link.close(),
  };
}
