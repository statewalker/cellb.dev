import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Env = { COUNTER: DurableObjectNamespace<Counter> };

export class Counter extends DurableObject {
  increment(): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY, n INTEGER)");
    sql.exec("INSERT INTO c (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1");
    return sql.exec<{ n: number }>("SELECT n FROM c WHERE id = 1").one().n;
  }
}

const app = new Hono<{ Bindings: Env }>();
app.get("/api/hello", (c) => c.json({ hello: "world", runtime: navigator.userAgent }));
app.get("/api/count/:name", async (c) => {
  const stub = c.env.COUNTER.get(c.env.COUNTER.idFromName(c.req.param("name")));
  return c.json({ name: c.req.param("name"), n: await stub.increment() });
});

export default app;
