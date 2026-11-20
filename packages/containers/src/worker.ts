// The worker side of an isolated container: one engine, served to the pool over a port.
import type { ContainerEngine } from "./engine.ts";
import type { PortLike } from "./rpc.ts";

/** What a worker's engine factory gets: the port its guests' filesystem calls go to. */
export interface ContainerWorkerContext {
  files: PortLike;
}

/**
 * Serves one engine from inside a worker (`self` in a Web Worker, `parentPort` in Node). The pool
 * sends `{ engine, files }` ports; `makeEngine` builds the engine, wiring `files` its own way.
 */
export function serveContainerWorker(
  _endpoint: PortLike,
  _makeEngine: (ctx: ContainerWorkerContext) => ContainerEngine,
): void {
  throw new Error("not implemented");
}
