import { describe, expect, it } from "vitest";
import { CfWebSocket, takeClientEnd, takeClientPort, WebSocketPair } from "../src/ws/server.js";

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

  it("takeClientEnd hands over the pair's own port with the early frames, which a new end replays", async () => {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const fromClient: string[] = [];
    server.addEventListener("message", (e: Event) =>
      fromClient.push(String((e as MessageEvent).data)),
    );
    server.send("hello");
    await tick();
    const { port, frames } = takeClientEnd(client);
    expect(frames).toEqual([{ t: "m", d: "hello" }]);
    // The holder replays the early frames, then reads the pair's own port: no relay.
    const end = new CfWebSocket(port, frames);
    const got: string[] = [];
    end.addEventListener("message", (e: Event) => got.push(String((e as MessageEvent).data)));
    server.send("second");
    await tick();
    end.accept();
    await tick();
    expect(got).toEqual(["hello", "second"]);
    end.send("from client");
    await tick();
    expect(fromClient).toEqual(["from client"]);
    end.close(1000);
    await tick();
  });

  it("goAway reaches a server end whose client was handed over but which was never accepted", async () => {
    const [client] = Object.values(new WebSocketPair());
    const got = frames(takeClientPort(client));
    CfWebSocket.goAway("bye");
    await tick();
    expect(got).toEqual([{ t: "c", code: 1001, reason: "bye" }]);
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
