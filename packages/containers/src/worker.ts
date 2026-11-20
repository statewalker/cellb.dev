// The worker side of an isolated container: one engine, served to the pool over a port.
import type { ContainerEngine } from "./engine.ts";
import { onMessage } from "./files/bridge.ts";
import { type PortLike, serveEngine } from "./rpc.ts";

/** What a worker's engine factory gets: the port its guests' filesystem calls go to. */
export interface ContainerWorkerContext {
  files: PortLike;
}

/**
 * Serves one engine from inside a worker (`self` in a Web Worker, `parentPort` in Node). The pool
 * sends `{ engine, files }` ports; `makeEngine` builds the engine, wiring `files` its own way.
 */
export function serveContainerWorker(
  endpoint: PortLike,
  makeEngine: (ctx: ContainerWorkerContext) => ContainerEngine,
): void {
  let served = false;
  onMessage(endpoint, (data: { engine?: PortLike; files?: PortLike }) => {
    if (served || !data?.engine || !data.files) return;
    served = true;
    serveEngine(data.engine, makeEngine({ files: data.files }));
  });
}
