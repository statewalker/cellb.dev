// A task is one call to a Task object: some CPU work, then a row of `kb` random (incompressible)
// kilobytes in the object's SQLite. Each row records the worker that ran it, so a probe can check
// that every object lives in one worker and count how the tasks spread.
import { DurableObject } from "cloudflare:workers";

// The worker's name: a browser Dedicated Worker's `name`, or what a Node thread sets.
const workerName = () => globalThis.__spreadWorker ?? globalThis.name ?? "main";

export class Task extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, worker TEXT, payload BLOB)",
    );
  }

  run(kb, work) {
    let h = 0;
    for (let i = 0; i < work; i++) h = (Math.imul(h ^ i, 2654435761) + 1) | 0;
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO runs (worker, payload) VALUES (?, randomblob(?))",
      workerName(),
      kb * 1024,
    );
    const [{ n }] = sql.exec("SELECT count(*) AS n FROM runs").toArray();
    return { n, worker: workerName(), h };
  }

  stats() {
    const [row] = this.ctx.storage.sql
      .exec(
        "SELECT count(*) AS n, coalesce(sum(length(payload)), 0) AS bytes, count(DISTINCT worker) AS workers FROM runs",
      )
      .toArray();
    return row;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.TASK.getByName(url.searchParams.get("name") ?? "task");
    if (url.pathname === "/stats") return Response.json(await stub.stats());
    const kb = Number(url.searchParams.get("kb") ?? 0);
    const work = Number(url.searchParams.get("work") ?? 0);
    return Response.json(await stub.run(kb, work));
  },
};
