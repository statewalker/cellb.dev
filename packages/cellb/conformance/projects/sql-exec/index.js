// sql.exec() of SQL text that holds no statement, or ends in one: what runs and what is
// refused (workerd: "SQL code did not contain a statement").
import { DurableObject } from "cloudflare:workers";

const tryIt = (fn) => {
  try {
    return fn();
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 150)}`;
  }
};

export class Store extends DurableObject {
  exec() {
    const sql = this.ctx.storage.sql;
    const rows = (q) => tryIt(() => sql.exec(q).toArray());
    return Object.fromEntries(
      [
        "",
        "   ",
        ";",
        "-- a comment",
        "SELECT 1 AS n",
        "SELECT 1 AS n;",
        "SELECT 1 AS n;   ",
        "SELECT 1 AS n; -- a comment",
        "SELECT 1 AS n; /* a comment */",
        "SELECT 1 AS n -- a comment",
        "SELECT 1 AS n; SELECT 2 AS n",
        "SELECT 1 AS n; ;",
        "SELECT 1 AS n;; SELECT 2 AS n",
        "SELECT ';' AS n; -- a comment",
      ].map((q) => [JSON.stringify(q), rows(q)]),
    );
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.STORE.getByName("s").exec());
  },
};
