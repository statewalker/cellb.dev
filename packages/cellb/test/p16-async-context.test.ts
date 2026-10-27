import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { createCellRuntime, DurableObject, type DurableObjectNamespace } from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

// On Cloudflare a call to a Durable Object is a new event: the callee sees no AsyncLocalStorage
// store its caller set. cellb starts every event (and the constructor) in the context the
// runtime was made in.
const request = new AsyncLocalStorage<string>();
const deployment = new AsyncLocalStorage<string>();

class Probe extends DurableObject {
  constructedWith = { request: request.getStore(), deployment: deployment.getStore() };
  seen() {
    return {
      request: request.getStore() ?? null,
      deployment: deployment.getStore() ?? null,
      constructedWith: this.constructedWith,
    };
  }
  async callOther(name: string) {
    // A store set in this object does not reach the object it calls either.
    return request.run("set-in-caller-object", () =>
      (this.env as { PROBE: DurableObjectNamespace }).PROBE.getByName(name).seen(),
    );
  }
}

describe("P16 every event starts in the runtime's own async context", () => {
  it("a called object sees the runtime's stores, not its caller's", async () => {
    const runtime = deployment.run("deployment-1", () =>
      createCellRuntime({
        worker: { Probe, default: {} },
        durableObjects: { PROBE: { className: "Probe" } },
        openSql: nodeSqliteOpener(),
      }),
    );
    try {
      const ns = runtime.env.PROBE as DurableObjectNamespace;
      const direct = await request.run("set-by-caller", () => (ns.getByName("a") as any).seen());
      expect(direct).toEqual({
        request: null,
        deployment: "deployment-1",
        constructedWith: { request: undefined, deployment: "deployment-1" },
      });
      const viaObject = await (ns.getByName("b") as any).callOther("c");
      expect(viaObject.request).toBeNull();
      expect(viaObject.deployment).toBe("deployment-1");
    } finally {
      await runtime.close();
    }
  });
});
