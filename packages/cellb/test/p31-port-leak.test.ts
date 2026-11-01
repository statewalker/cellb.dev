import { describe, expect, it } from "vitest";

// Every exchange over a port link must release its multiplexed port: with a small maxPorts,
// many more requests than ports must still succeed, whatever the method and body.
describe("port links release their multiplexed ports", () => {
  it.each(["GET", "HEAD", "POST", "GET-unread"])(
    "%s",
    async (kind) => {
      (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts = 16;
      const { linkOverPort, serveHandlerOverPort } = await import("../src/transport/port.js");
      const { port1, port2 } = new MessageChannel();
      await serveHandlerOverPort(
        port2,
        async (req: Request) =>
          new Response(
            req.method === "HEAD"
              ? null
              : `ok ${new URL(req.url).pathname} ${req.method === "POST" ? await req.text() : ""}`,
          ),
      );
      const { send, close } = await linkOverPort(port1);
      try {
        for (let i = 0; i < 200; i++) {
          const method = kind === "GET-unread" ? "GET" : kind;
          const res: Response = await send(
            new Request(`http://x/r${i}`, { method, body: method === "POST" ? "b" : undefined }),
          );
          expect(res.status).toBe(200);
          if (kind !== "GET-unread") await res.text();
          else await res.body?.cancel();
        }
      } finally {
        await close();
        port1.close();
        port2.close();
        delete (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts;
      }
    },
    60_000,
  );
});
