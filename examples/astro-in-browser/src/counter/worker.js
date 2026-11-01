// A counter Durable Object per name: POST …/<name> adds one, GET reads (plain JS, no imports).
const { DurableObject } = globalThis.__cellsWorkersModule;

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)",
    );
  }
  fetch(request) {
    if (request.method === "POST")
      this.ctx.storage.sql.exec("INSERT INTO hits (at) VALUES (?)", Date.now());
    const n = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM hits").one().n;
    return Response.json({ n });
  }
}

export default {
  fetch(request, env) {
    const name = new URL(request.url).pathname.split("/").pop();
    return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(request);
  },
};
