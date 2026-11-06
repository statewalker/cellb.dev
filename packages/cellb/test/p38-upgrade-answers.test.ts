import { describe, expect, it } from "vitest";
import { hostPort, isolatePort, type PortLike } from "../src/isolate/protocol.js";

const upgrade = () => new Request("http://cell/ws", { headers: { Upgrade: "websocket" } });

// An upgrade's answer always arrives or fails: it never waits for ever.
describe("P38 upgrade answers across an isolate's port", () => {
  it("an error that cannot be copied still reaches the host, by name and message", async () => {
    const { port1, port2 } = new MessageChannel();
    isolatePort(
      port2 as unknown as PortLike,
      async () => undefined,
      async () => {
        throw Object.assign(new TypeError("no socket here"), { cause: { f: () => 1 } });
      },
    );
    const { fetch } = await hostPort(port1 as unknown as PortLike, async () => undefined);
    try {
      const err = await fetch({ name: "default" }, upgrade()).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.name).toBe("TypeError");
      expect(err?.message).toBe("no socket here");
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("a port the isolate refuses fails the upgrade instead of leaving it pending", async () => {
    const { port1, port2 } = new MessageChannel();
    const g = globalThis as { __cellbMaxPorts?: number };
    // The host's table is roomier than the isolate's: the isolate refuses the second port.
    g.__cellbMaxPorts = 64;
    let host: Awaited<ReturnType<typeof hostPort>>;
    try {
      host = await hostPort(port1 as unknown as PortLike, async () => undefined);
    } finally {
      delete g.__cellbMaxPorts;
    }
    g.__cellbMaxPorts = 1;
    isolatePort(
      port2 as unknown as PortLike,
      async () => undefined,
      () => new Promise(() => {}),
    );
    delete g.__cellbMaxPorts;
    try {
      const outcome = await Promise.race([
        host.fetch({ name: "default" }, upgrade()).then(
          () => "answered",
          () => "failed",
        ),
        new Promise((r) => setTimeout(() => r("pending"), 2_000)),
      ]);
      expect(outcome).toBe("failed");
    } finally {
      port1.close();
      port2.close();
    }
  });
});
