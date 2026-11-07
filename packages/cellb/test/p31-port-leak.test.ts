import { afterEach, describe, expect, it } from "vitest";

// Every exchange over a port link must release its multiplexed port, however it ends: with a small
// maxPorts, many more requests than ports must still succeed. The links are webrun-http-browser's
// (connectHttpLink / serveHttpLink); this pins that cellb's links over them (linkOverPort,
// serveHandlerOverPort) give their ports back.

const MAX_PORTS = 16;
const ROUNDS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  delete (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts;
});

async function linked(handler: (req: Request) => Promise<Response>) {
  (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts = MAX_PORTS;
  const { linkOverPort, serveHandlerOverPort } = await import("../src/transport/port.js");
  const { port1, port2 } = new MessageChannel();
  const stop = await serveHandlerOverPort(port2, handler);
  const link = await linkOverPort(port1);
  closers.push(
    link.close,
    stop,
    () => port1.close(),
    () => port2.close(),
  );
  return link;
}

describe("port links release their multiplexed ports", () => {
  it.each(["GET", "HEAD", "POST", "GET-unread", "OPTIONS"])(
    "%s",
    async (kind) => {
      const { send } = await linked(
        async (req: Request) =>
          new Response(
            req.method === "HEAD" || req.method === "OPTIONS"
              ? null
              : `ok ${new URL(req.url).pathname} ${req.method === "POST" ? await req.text() : ""}`,
          ),
      );
      for (let i = 0; i < ROUNDS * 2; i++) {
        const method = kind === "GET-unread" ? "GET" : kind;
        const res: Response = await send(
          new Request(`http://x/r${i}`, { method, body: method === "POST" ? "b" : undefined }),
        );
        expect(res.status).toBe(200);
        if (kind !== "GET-unread") await res.text();
        else await res.body?.cancel();
      }
    },
    60_000,
  );

  it.each([204, 304, 404])("status %d", async (status) => {
    const { send } = await linked(
      async () => new Response(status === 404 ? "missing" : null, { status }),
    );
    for (let i = 0; i < ROUNDS; i++) {
      const res = await send(new Request(`http://x/r${i}`));
      expect(res.status).toBe(status);
      await res.text();
    }
  });

  it("a streamed response read to its end", async () => {
    const { send } = await linked(async () => {
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ === 8) c.close();
            else c.enqueue(new Uint8Array(4096));
          },
        }),
      );
    });
    for (let i = 0; i < ROUNDS; i++)
      expect((await (await send(new Request("http://x/"))).arrayBuffer()).byteLength).toBe(32768);
  });

  it("the handler throws", async () => {
    const { send } = await linked(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < ROUNDS; i++)
      await expect(send(new Request("http://x/"))).rejects.toThrow("boom");
  });

  it("a handler that answers first and reads the upload afterwards gets all of it", async () => {
    const received: number[] = [];
    const { send } = await linked(async (req) => {
      void req.arrayBuffer().then(
        (b) => received.push(b.byteLength),
        () => received.push(-1),
      );
      return new Response("accepted", { status: 202 });
    });
    for (let i = 0; i < ROUNDS / 2; i++) {
      const res = await send(
        new Request("http://x/", { method: "PUT", body: new Uint8Array(70_000) }),
      );
      expect(await res.text()).toBe("accepted");
      for (let k = 0; k < 200 && received.length <= i; k++) await sleep(5);
    }
    expect(received).toEqual(Array(ROUNDS / 2).fill(70_000));
  });

  it("aborted requests to a handler that never answers give their ports back", async () => {
    let started = 0;
    const { send } = await linked(async () => {
      started++;
      return await new Promise<Response>(() => {});
    });
    for (let i = 0; i < MAX_PORTS * 3; i++) {
      const controller = new AbortController();
      const pending = send(new Request("http://x/", { signal: controller.signal }));
      for (let k = 0; k < 100 && started <= i; k++) await sleep(2);
      controller.abort(new Error("gave up"));
      await expect(pending).rejects.toThrow("gave up");
    }
    expect(started).toBe(MAX_PORTS * 3);
  });
  it("the ceiling is real: past it, a request is refused (so the cases above can fail)", async () => {
    const { send } = await linked(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(1024));
          },
        }),
      );
    });
    // One at a time: each exchange holds one port, but while it opens it briefly takes a second
    // (webrun-http-browser 0.12's pipelined bodies), so MAX_PORTS at once would hit the ceiling
    // before all are held.
    const held: Response[] = [];
    for (let i = 0; i < MAX_PORTS; i++) held.push(await send(new Request("http://x/")));
    await expect(send(new Request("http://x/"))).rejects.toThrow(/maxPorts/);
    for (const res of held) await res.body?.cancel();
    await sleep(20);
    expect((await send(new Request("http://x/", { method: "HEAD" }))).status).toBe(200);
  });
});
