// A ContainerEngine in another thread: serveEngine() where it runs, connectEngine() where cells run.
import type { ContainerEngine } from "./engine.ts";

export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export function serveEngine(_port: PortLike, _engine: ContainerEngine): void {
  throw new Error("not implemented");
}

export function connectEngine(_port: PortLike): ContainerEngine {
  throw new Error("not implemented");
}
