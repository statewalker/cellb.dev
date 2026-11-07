// The project the "Running from sources" page builds in the browser: TypeScript, an npm package
// (Hono) and a Durable Object, as a developer would write them. Nothing here is compiled ahead
// of time; the page's worker (worker.ts) bundles it when you press the button.
export const files: Record<string, string> = {
  "src/index.ts": `import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

// One Visits object per name, counting in its own SQLite database
export class Visits extends DurableObject {
  hit(): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, n INTEGER)");
    sql.exec("INSERT INTO hits VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1");
    return sql.exec<{ n: number }>("SELECT n FROM hits").one().n;
  }
}

type Env = { VISITS: DurableObjectNamespace<Visits> };
const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Try /hello/your-name"));
app.get("/hello/:name", async (c) => {
  const name = c.req.param("name");
  const visits = await c.env.VISITS.getByName(name).hit();
  return c.json({ hello: name, visits });
});

export default app;
`,
  "wrangler.jsonc": `{
  "name": "hello-hono",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "VISITS", "class_name": "Visits" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Visits"] }]
}
`,
  "package.json": `{
  "name": "hello-hono",
  "private": true,
  "type": "module",
  "dependencies": { "hono": "^4.6.0" }
}
`,
};
