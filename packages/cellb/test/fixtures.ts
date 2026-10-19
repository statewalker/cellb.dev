import { CellsResponse, DurableObject, WebSocketPair, type WorkerModule } from "../src/index.js";

export interface Env {
  COUNTER: import("../src/index.js").DurableObjectNamespace;
  ROOM: import("../src/index.js").DurableObjectNamespace;
}

/** A Wrangler-style Worker module, written exactly as for Cloudflare/celld. */
export class Counter extends DurableObject<Env> {
  static constructed = 0;
  constructor(ctx: any, env: Env) {
    super(ctx, env);
    Counter.constructed++;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0)");
    });
  }
  increment(by = 1): number {
    this.ctx.storage.sql.exec("UPDATE counter SET n = n + ? WHERE id = 1", by);
    return this.value();
  }
  /** Which shard hosts this object (SHARD var set by the shard host). */
  shard(): number | undefined {
    return (this.env as any).SHARD;
  }
  /** DO → DO call, possibly into another shard. */
  async bump(
    other: string,
    by: number,
  ): Promise<{ me: number | undefined; other: number | undefined; n: number }> {
    const stub = this.env.COUNTER.getByName(other);
    const n = await stub.increment(by);
    return { me: this.shard(), other: await stub.shard(), n };
  }
  /** Holds the event open for `ms` (to have requests in flight when an owner dies). */
  async slow(ms: number): Promise<number> {
    await new Promise((r) => setTimeout(r, ms));
    return this.value();
  }
  value(): number {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counter WHERE id = 1").one().n;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/inc"))
      return Response.json({ n: this.increment() });
    if (url.pathname.endsWith("/ticks")) {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async start(c) {
          for (let i = 0; i < 3; i++) {
            c.enqueue(enc.encode(`data: ${i}\n\n`));
            await new Promise((r) => setTimeout(r, 30));
          }
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/whoami"))
      return Response.json({
        url: req.url,
        internal: [...req.headers.keys()].filter((h) => h.startsWith("x-webrun-cells")),
      });
    return Response.json({ n: this.value(), id: this.ctx.id.toString(), name: this.ctx.id.name });
  }
}

/**
 * Echo room with Cloudflare-style WebSockets — the protocol shared with the reference
 * `ws` server (test/ws-reference-server.ts) so the same conformance cases run against
 * native WebSockets and webrun-cells sockets:
 *   text → broadcast to every socket of the room; binary → reversed bytes to the sender;
 *   "where?" → "where:shard<N>"; "count?" → "count:<sockets>"; "big:<n>" → n × "x";
 *   "bye" → server closes 4000 "bye bye"; "relay:<room>:<text>" → see relay();
 *   the subprotocol is the client's first offer.
 */
export class Room extends DurableObject<Env> {
  sockets = new Set<any>();

  /**
   * "relay:<room>:<text>": this object becomes a WebSocket CLIENT of another Room (as in
   * Cloudflare: stub.fetch with an Upgrade request, then `res.webSocket.accept()`), sends
   * <text>, and answers "relayed:<room>:<reply>:<protocol>" — possibly across shards.
   */
  async relay(server: any, d: string): Promise<void> {
    const [, room, text] = d.split(":");
    const res: any = await this.env.ROOM.getByName(room).fetch("http://room/", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "relay.v1" },
    });
    const ws = res.webSocket;
    if (res.status !== 101 || !ws) return server.send(`relay-failed:${res.status}`);
    ws.accept();
    ws.addEventListener("message", (e: any) => {
      server.send(`relayed:${room}:${e.data}:${res.headers.get("Sec-WebSocket-Protocol")}`);
      ws.close(1000, "relay done");
    });
    ws.send(text);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("message", (e: any) => {
      const d = e.data;
      if (typeof d !== "string") return server.send(new Uint8Array(d).reverse());
      if (d === "where?") return server.send(`where:shard${(this.env as any).SHARD}`);
      if (d === "count?") return server.send(`count:${this.sockets.size}`);
      if (d.startsWith("big:")) return server.send("x".repeat(Number(d.slice(4))));
      if (d === "bye") return server.close(4000, "bye bye");
      if (d.startsWith("relay:")) return void this.relay(server, d);
      for (const s of this.sockets) s.send(d);
    });
    server.addEventListener("close", () => this.sockets.delete(server));
    const offered = req.headers.get("Sec-WebSocket-Protocol")?.split(",")[0]?.trim();
    return new CellsResponse(null, {
      status: 101,
      webSocket: pair[0],
      headers: offered ? { "Sec-WebSocket-Protocol": offered } : {},
    });
  }
}

export const worker: WorkerModule = {
  Counter,
  Room,
  default: {
    async fetch(req: Request, env: Env) {
      const [, kind, name, ...rest] = new URL(req.url).pathname.split("/");
      if (kind === "room" && name) return (env as any).ROOM.getByName(name).fetch(req);
      if (kind === "echo")
        return new Response(req.body ? await req.arrayBuffer() : null, {
          status: 201,
          headers: {
            "x-echo": req.headers.get("x-test") ?? "",
            "content-type": req.headers.get("content-type") ?? "",
          },
        });
      if (kind !== "counter" || !name) return new Response("not found", { status: 404 });
      const stub = env.COUNTER.getByName(name);
      if (rest[0] === "rpc")
        return Response.json({ n: await stub.increment(Number(rest[1] ?? 1)) });
      if (rest[0] === "slow") return Response.json({ n: await stub.slow(Number(rest[1] ?? 1000)) });
      if (rest[0] === "shard") return Response.json({ shard: await stub.shard() });
      if (rest[0] === "bump") return Response.json(await stub.bump(rest[1], 1));
      return stub.fetch(req);
    },
  },
};
