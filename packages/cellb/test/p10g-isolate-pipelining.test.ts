import { describe, expect, it } from "vitest";
import { RpcTarget } from "../src/core/durable-object.js";
import { hostPort, isolatePort, type PortLike } from "../src/isolate/protocol.js";

// Promise pipelining across an isolate's port, counted at the port: in
// `factory.make().inc()`, loaded code sends `inc` while the host is still computing `make()`,
// instead of waiting a round trip for its answer.
describe("P10g promise pipelining across an isolate", () => {
  it("sends a call on a pending result before that result answers", async () => {
    const { port1, port2 } = new MessageChannel();
    const posted: string[] = []; // what the isolate's end posts
    const post = port2.postMessage.bind(port2);
    port2.postMessage = ((m: unknown, t: Transferable[]) => {
      posted.push(JSON.stringify(m));
      post(m, t);
    }) as typeof port2.postMessage;
    isolatePort(
      port2 as unknown as PortLike,
      async (m: { factory: { make(): { inc(): Promise<number> } } }) => m.factory.make().inc(),
      async () => new Response(),
    );
    class Counter extends RpcTarget {
      inc() {
        return 1;
      }
    }
    let incSentBeforeMakeAnswered = false;
    class Factory extends RpcTarget {
      async make() {
        await new Promise((r) => setTimeout(r, 100));
        incSentBeforeMakeAnswered = posted.some((m) => m.includes('"inc"'));
        return new Counter();
      }
    }
    const { call } = await hostPort(port1 as unknown as PortLike, async () => undefined);
    try {
      expect(await call({ type: "go", factory: new Factory() })).toBe(1);
      expect(incSentBeforeMakeAnswered).toBe(true);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
