// sql.ingest(): runs the complete statements of a chunk of SQL text and returns the rest, for
// SQL that arrives in pieces. What is complete, what it counts, and how it fails part-way.
import { DurableObject } from "cloudflare:workers";

const tryIt = (fn) => {
  try {
    return fn();
  } catch (e) {
    return `${e.name}: ${String(e.message).split("\n")[0].slice(0, 150)}`;
  }
};
const counts = ({ remainder, statementCount, rowsRead, rowsWritten }) => ({
  remainder,
  statementCount,
  rowsRead,
  rowsWritten,
});

export class Store extends DurableObject {
  ingest() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const values = () => sql.exec("SELECT v FROM t ORDER BY id").toArray().map((r) => r.v);
    const remainders = [
      "SELECT 1; SELECT 2;   ",
      "SELECT 1; SELECT 2",
      "SELECT 1;",
      "SELECT 1",
      "",
      "   ",
      "SELECT 1; -- a comment",
      "SELECT 1; /* a comment */",
      "SELECT 'a;b'; SELECT 'c",
      "SELECT 1; CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;",
    ].map((q) => tryIt(() => sql.ingest(q).remainder));
    return {
      remainders,
      writes: tryIt(() =>
        counts(
          sql.ingest(
            "INSERT INTO t (v) VALUES ('a'), ('b'); INSERT INTO t (v) VALUES ('c'); SELECT * FROM t; UPDATE t SET v = 'z' WHERE id = 1; DELE",
          ),
        ),
      ),
      trigger: tryIt(() =>
        counts(
          sql.ingest(
            "CREATE TRIGGER tr AFTER DELETE ON t BEGIN INSERT INTO t (v) VALUES ('t'); END; DELETE FROM t WHERE id = 3;",
          ),
        ),
      ),
      afterWrites: values(),
      syntax: tryIt(() => sql.ingest("SELECT * bunk;")),
      misspelled: tryIt(() => sql.ingest("INSER INTO t VALUES (1);")),
      noTable: tryIt(() => sql.ingest("INSERT INTO missing VALUES (1);")),
      constraint: tryIt(() => sql.ingest("INSERT INTO t (id, v) VALUES (1, 'dup');")),
      partly: tryIt(() => sql.ingest("INSERT INTO t (v) VALUES ('before'); SELECT * bunk;")),
      afterPartly: values(),
      transaction: tryIt(() => sql.ingest("BEGIN TRANSACTION;")),
      internal: tryIt(() => sql.ingest("SELECT * FROM _cf_KV;")),
      parameter: tryIt(() => counts(sql.ingest("SELECT ?;"))),
      notString: tryIt(() => counts(sql.ingest(42))),
    };
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.STORE.getByName("s").ingest());
  },
};
