import { DurableObject } from "cloudflare:workers";
import { threadId } from "node:worker_threads";

// A counter that says which worker thread ran it; `bump` calls another counter (DO → DO).
export class Counter extends DurableObject {
  inc() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY)");
    sql.exec("INSERT INTO hits DEFAULT VALUES");
    const [{ n }] = sql.exec("SELECT count(*) AS n FROM hits").toArray();
    return { n, thread: threadId };
  }
  async bump(other) {
    const r = await this.env.COUNTER.getByName(other).inc();
    return { me: threadId, other: r.thread, n: r.n };
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.COUNTER.getByName(url.searchParams.get("name"));
    const other = url.searchParams.get("bump");
    return Response.json(other ? await stub.bump(other) : await stub.inc());
  },
};
