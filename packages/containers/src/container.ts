// ctx.container: Cloudflare's container API (as celld implements it) over a ContainerEngine.

// ctx.container's implementation is cellb's: objects of a `containers` class get it from the
// runtime (loadProject(…, { containers: engine })). createContainer is re-exported for code that
// drives containers itself (the pools, hosts without a cellb runtime).
import { type Container, createContainer } from "@statewalker/cellb/container";
import type { ContainerEngine, ContainerSpec } from "./engine.ts";

export { type Container, createContainer, type StartOptions } from "@statewalker/cellb/container";

// The node's engine, for containerFor(). On globalThis under a registered symbol: a project's
// bundle carries its own copy of this module, and must still find the engine the host provided.
const ENGINE = Symbol.for("@statewalker/cellb-containers/engine");
type Holder = { [ENGINE]?: ContainerEngine };

/** Makes `engine` the node's engine for containerFor(); the returned function withdraws it and
 * destroys its containers (a node stop). */
export function provideContainerEngine(engine: ContainerEngine): () => Promise<void> {
  (globalThis as Holder)[ENGINE] = engine;
  return async () => {
    if ((globalThis as Holder)[ENGINE] === engine) delete (globalThis as Holder)[ENGINE];
    await engine.close();
  };
}

/**
 * A Durable Object's container on the engine the host provided with provideContainerEngine(), for
 * objects that cannot get `ctx.container` (a runtime without a container engine, or a class with
 * no image in the manifest). Prefer ctx.container: loadProject(…, { containers: engine }).
 */
export function containerFor(
  ctx: { id: { name?: string; toString(): string } },
  image: ContainerSpec,
): Container {
  const engine = (globalThis as Holder)[ENGINE];
  if (!engine)
    throw new Error("this node has no container engine: call provideContainerEngine() in the host");
  return createContainer(engine, image, { label: ctx.id.name ?? ctx.id.toString() });
}
