// Durable Object storage details: KV API (async and sync), list options, multi-key calls,
// limits, SQL cursors and refused statements, nested transactions, alarms edge cases.
import { DurableObject } from "cloudflare:workers";

const tryIt = async (fn) => {
  try {
    const v = await fn();
    return v === undefined ? "ok" : v;
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 150)}`;
  }
};
const entries = (m) => [...m.entries()];

export class Store extends DurableObject {
  async kv() {
    const s = this.ctx.storage;
    await s.put({ a: 1, b: { n: 2 }, c: [3], d: new Date(0), e: new Map([["k", 1]]), "p/1": 1, "p/2": 2, "p/3": 3, q: 4 });
    return {
      getMany: entries(await s.get(["a", "b", "missing"])),
      date: (await s.get("d")) instanceof Date,
      map: (await s.get("e")) instanceof Map,
      list: [...(await s.list()).keys()],
      prefix: [...(await s.list({ prefix: "p/" })).keys()],
      range: [...(await s.list({ start: "b", end: "p/2" })).keys()],
      startAfter: [...(await s.list({ startAfter: "p/1", limit: 2 })).keys()],
      reverse: [...(await s.list({ reverse: true, limit: 3 })).keys()],
      deleteMany: await s.delete(["a", "b", "missing"]),
      deleteOne: await s.delete("c"),
      deleteMissing: await s.delete("c"),
      syncGet: s.kv.get("q"),
      syncList: [...s.kv.list({ prefix: "p/" })].map(([k]) => k),
      undefinedValue: await tryIt(() => s.put("u", undefined)),
      fnValue: await tryIt(() => s.put("f", () => 1)),
      bigKey: await tryIt(() => s.put("k".repeat(2049), 1)),
      okKey: await tryIt(() => s.put("k".repeat(2048), 1)),
      tooManyKeys: await tryIt(async () => (await s.get(Array.from({ length: 129 }, (_, i) => `x${i}`))).size),
      undefinedBack: String(await s.get("u")),
      emptyGet: entries(await s.get([])),
    };
  }

  async sql() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)");
    const ins = sql.exec("INSERT INTO t (v, b) VALUES (?, ?), (?, ?)", "x", new Uint8Array([1, 2]), "y", null);
    const cur = sql.exec("SELECT id, v, b FROM t ORDER BY id");
    const first = cur.next();
    const rest = cur.toArray();
    const raw = [...sql.exec("SELECT v FROM t ORDER BY id").raw()];
    return {
      rowsWritten: ins.rowsWritten,
      columnNames: cur.columnNames,
      first: { done: first.done, v: first.value.v, b: [...new Uint8Array(first.value.b)] },
      rest: rest.map((r) => r.v),
      raw,
      one: await tryIt(() => sql.exec("SELECT v FROM t").one()),
      oneOk: sql.exec("SELECT count(*) AS n FROM t").one().n,
      begin: await tryIt(() => sql.exec("BEGIN")),
      cfTable: await tryIt(() => sql.exec("SELECT * FROM _cf_KV")),
      multi: await tryIt(() => sql.exec("INSERT INTO t (v) VALUES ('m1'); INSERT INTO t (v) VALUES ('m2')").rowsWritten),
      dbSize: typeof sql.databaseSize,
      bindingCount: await tryIt(() => sql.exec("SELECT ?", 1, 2)),
    };
  }

  async txn() {
    const s = this.ctx.storage;
    const out = {};
    s.transactionSync(() => {
      s.sql.exec("CREATE TABLE IF NOT EXISTS n (v TEXT)");
      s.sql.exec("INSERT INTO n VALUES ('outer')");
      try {
        s.transactionSync(() => {
          s.sql.exec("INSERT INTO n VALUES ('inner')");
          throw new Error("inner fails");
        });
      } catch (e) {
        out.innerError = e.message;
      }
    });
    out.rows = s.sql.exec("SELECT v FROM n").toArray().map((r) => r.v);
    out.asyncTxn = await tryIt(() =>
      s.transaction(async (txn) => {
        await txn.put("t1", 1);
        txn.rollback();
      }),
    );
    out.afterRollback = (await s.get("t1")) ?? null;
    out.argCount = await tryIt(() => s.transactionSync((...args) => args.length));
    return out;
  }

  async alarms() {
    const s = this.ctx.storage;
    return {
      past: await tryIt(() => s.setAlarm(Date.now() - 60_000)),
      nan: await tryIt(() => s.setAlarm(Number.NaN)),
      afterNan: String(await s.getAlarm()),
      string: await tryIt(() => s.setAlarm("soon")),
      afterString: String(await s.getAlarm()),
      date: await tryIt(() => s.setAlarm(new Date(Date.now() + 3_600_000))),
      afterDateIsNumber: typeof (await s.getAlarm()),
      deleteNone: await tryIt(() => s.deleteAlarm()),
    };
  }
}

export default {
  async fetch(request, env) {
    const op = new URL(request.url).pathname.slice(1);
    const stub = env.S.getByName(op);
    return Response.json(await stub[op]());
  },
};
