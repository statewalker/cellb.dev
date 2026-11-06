import { describe, expect, it } from "vitest";
import { takeClientPort, WebSocketPair } from "../src/ws/server.js";

// A server that sends before its 101 response is handed over (partyserver greets the socket in
// onConnect, then returns the response): the frame reaches the client end of the pair, which
// is never accepted and queues it. takeClientPort hands those frames to the new holder first.
describe("P37 frames sent before the client end is handed over", () => {
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const frames = (port: MessagePort) => {
    const got: unknown[] = [];
    port.onmessage = (e) => got.push(e.data);
    return got;
  };

  it("keeps a frame the client end already received, in order, and relays both ways", async () => {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const fromClient: string[] = [];
    server.addEventListener("message", (e: Event) =>
      fromClient.push(String((e as MessageEvent).data)),
    );
    server.send("hello");
    await tick(); // delivered to the client end, which queues it
    const port = takeClientPort(client);
    const got = frames(port);
    server.send("second");
    await tick();
    expect(got).toEqual([
      { t: "m", d: "hello" },
      { t: "m", d: "second" },
    ]);
    port.postMessage({ t: "m", d: "from client" });
    await tick();
    expect(fromClient).toEqual(["from client"]);
    port.close();
  });

  it("hands over the pair's own port when nothing arrived early", async () => {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const port = takeClientPort(client);
    const got = frames(port);
    server.send("late");
    await tick();
    expect(got).toEqual([{ t: "m", d: "late" }]);
    port.close();
  });
});
