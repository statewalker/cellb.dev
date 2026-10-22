// D1 and storage details celld documents: sessions/bookmarks, meta of read-only statements,
// refused statements, fts5, and Durable Object point-in-time-recovery APIs.
import { DurableObject } from "cloudflare:workers";

export class Obj extends DurableObject {
  async pitr() {
    const s = this.ctx.storage;
    const out = {};
    for (const [k, f] of Object.entries({
      current: () => s.getCurrentBookmark(),
      forTime: () => s.getBookmarkForTime(Date.now() - 1000),
      restore: async () => s.onNextSessionRestoreBookmark(await s.getCurrentBookmark()),
    })) {
      try {
        const v = await f();
        out[k] = typeof v;
      } catch (e) {
        out[k] = `${e.name}: ${e.message}`;
      }
    }
    return out;
  }
}

const tryIt = async (fn) => {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return String(e.message).split("\n")[0].slice(0, 120);
  }
};

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    const DB = env.DB;
    if (op === "session") {
      await DB.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
      const session = DB.withSession("first-unconstrained");
      const w = await session.prepare("INSERT INTO t (v) VALUES (?)").bind("x").run();
      const r = await session.prepare("SELECT count(*) AS n FROM t").first();
      const ro = await DB.prepare("SELECT v FROM t LIMIT 1").run();
      return Response.json({
        bookmark: session.getBookmark(),
        writeMeta: { changes: w.meta.changes, primary: w.meta.served_by_primary, region: w.meta.served_by_region },
        readCount: r.n,
        readOnlyMeta: { last_row_id: ro.meta.last_row_id, changes: ro.meta.changes },
      });
    }
    if (op === "refused") {
      return Response.json({
        begin: await tryIt(() => DB.exec("BEGIN")),
        attach: await tryIt(() => DB.prepare("ATTACH DATABASE 'x.db' AS x").run()),
        temp: await tryIt(() => DB.prepare("CREATE TEMP TABLE tt (a)").run()),
        vacuum: await tryIt(() => DB.prepare("VACUUM").run()),
        fts5: await tryIt(async () => {
          await DB.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body)").run();
          await DB.prepare("INSERT INTO docs (body) VALUES ('hello search world')").run();
          const hit = await DB.prepare("SELECT body FROM docs WHERE docs MATCH 'search'").first();
          if (!hit) throw new Error("no match");
        }),
      });
    }
    if (op === "pitr") return Response.json(await env.OBJ.getByName("p").pitr());
    return new Response("unknown op", { status: 404 });
  },
};
