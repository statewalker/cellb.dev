// A Durable Object as Workers code is written today: a class that extends DurableObject, its
// state in the object's own SQLite (ctx.storage.sql), and methods the Worker calls over RPC
// through a stub (env.COUNTER.getByName). cellb runs it unchanged, as Cloudflare, workerd and
// celld do: in this page's tabs, in Node, or on a celld fleet.
import { DurableObject } from "cloudflare:workers";

interface Env {
  COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, n INTEGER)");
  }

  /** Adds one and returns the new count; the write commits before the answer leaves. */
  increment(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "INSERT INTO counter (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1 RETURNING n",
      )
      .one().n;
  }
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    // One Counter per name, wherever it runs: an RPC call to its increment() method.
    const n = await env.COUNTER.getByName(name).increment();
    return Response.json({ name, n });
  },
} satisfies ExportedHandler<Env>;
