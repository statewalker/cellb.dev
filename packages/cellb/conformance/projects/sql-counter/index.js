// A counter on the SQL API only (user tables are the same bytes on celld and webrun-cells).
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  bump() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, n INTEGER)");
    sql.exec("INSERT INTO c (k, n) VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
    return sql.exec("SELECT n FROM c WHERE k = 'n'").one().n;
  }
}

export default {
  async fetch(request, env) {
    return Response.json({ n: await env.C.getByName("shared").bump() });
  },
};
