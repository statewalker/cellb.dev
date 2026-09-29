import { CellsResponse, DurableObject, WebSocketPair, type WorkerModule } from "../src/index.js";

export interface Env {
  COUNTER: import("../src/index.js").DurableObjectNamespace;
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

/** Chat room with Cloudflare-style WebSockets: broadcast, "where?" → hosting shard, "bye" → close. */
export class Room extends DurableObject<Env> {
  sockets = new Set<any>();
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    server.addEventListener("message", (e: any) => {
      if (e.data === "where?") return server.send(`shard:${(this.env as any).SHARD}`);
      if (e.data === "bye") return server.close(4000, "bye bye");
      for (const s of this.sockets) s.send(e.data);
    });
    server.addEventListener("close", () => this.sockets.delete(server));
    return new CellsResponse(null, { status: 101, webSocket: pair[0] });
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
