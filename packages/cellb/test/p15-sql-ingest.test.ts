import { describe, expect, it } from "vitest";
import {
  createCellRuntime,
  DurableObject,
  type DurableObjectNamespace,
  runInDurableObject,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

// workerd's `sql.ingest()` (experimental): an SQL dump read in chunks, with errors worded as
// celld words them (conformance project sql-ingest). The rest of the assertions are workerd's
// own (conformance/workerd-tests/wd-sql/sql-test.js), run on cellb directly.
class Box extends DurableObject {}

async function withSql(fn: (sql: any) => void | Promise<void>) {
  const runtime = createCellRuntime({
    worker: { Box, default: {} },
    durableObjects: { BOX: { className: "Box" } },
    openSql: nodeSqliteOpener(),
  });
  try {
    const stub = (runtime.env.BOX as DurableObjectNamespace).getByName("a");
    await runInDurableObject(stub as never, async (_i, ctx) => fn(ctx.storage.sql));
  } finally {
    await runtime.close();
  }
}

describe("P15 sql.ingest", () => {
  it("runs the complete statements and returns the rest", () =>
    withSql((sql) => {
      expect(sql.ingest("SELECT 123; SELECT 456;    ").remainder).toBe("    ");
      expect(sql.ingest("SELECT 123; SELECT 456;").remainder).toBe("");
      for (const tail of [" SELECT 456", " SELECT 45", " SELECT ", " SEL", " "])
        expect(sql.ingest(`SELECT 123;${tail}`).remainder).toBe(tail);
      expect(sql.ingest("SELECT 123").remainder).toBe("SELECT 123");
      // A trailing comment is a remainder for ingest, and no statement for exec.
      expect(sql.ingest("SELECT 123; SELECT 456; -- trailing comment").remainder).toBe(
        " -- trailing comment",
      );
      expect(() => sql.exec("SELECT 123; SELECT 456; -- trailing comment")).toThrow(
        /SQL code did not contain a statement/,
      );
      expect(() => sql.exec("")).toThrow(/SQL code did not contain a statement/);
      expect(() => sql.exec(";")).toThrow(/SQL code did not contain a statement/);
    }));

  it("throws on a complete statement that does not parse, as celld words it", () =>
    withSql((sql) => {
      expect(() => sql.ingest("SELECT * bunk;")).toThrow(
        /^SQL error: prepare ingested SQL: near "bunk": syntax error/,
      );
      expect(() => sql.ingest("INSER INTO xyz VALUES ('a'),('b');")).toThrow(
        /near "INSER": syntax error/,
      );
      expect(() => sql.ingest("INSERT INTO xyz VALUES ('a')('b');")).toThrow(
        /near "\(": syntax error/,
      );
    }));

  it("ingests a dump split into chunks of any size, strings and triggers included", () =>
    withSql((sql) => {
      sql.exec("CREATE TABLE streaming(val TEXT)");
      sql.exec("CREATE TABLE log(n INTEGER)");
      const dump = [
        "CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON streaming BEGIN INSERT INTO log VALUES (1); END;",
        ...Array.from(
          { length: 6 },
          (_, i) => `INSERT INTO streaming VALUES ('a;${i}'), ("b -- ${i}"), ('ü${i}');`,
        ),
        "/* done */",
      ].join("\n");
      for (const size of [1, 3, 9, 27, 81]) {
        sql.exec("DELETE FROM streaming");
        let buffer = "";
        let rows = 0;
        let statements = 0;
        for (let i = 0; i < dump.length; i += size) {
          const r = sql.ingest(buffer + dump.slice(i, i + size));
          buffer = r.remainder;
          rows += r.rowsWritten;
          statements += r.statementCount;
        }
        expect(buffer.trim()).toBe("/* done */");
        expect(sql.exec("SELECT count(*) AS n FROM streaming").one().n).toBe(18);
        expect(statements).toBe(7); // the trigger and the six inserts
        expect(rows).toBeGreaterThanOrEqual(18);
      }
    }));

  it("runs a trigger whose body holds CASE … END (EmDash's media-usage triggers)", () =>
    withSql((sql) => {
      sql.exec(`
        CREATE TABLE posts(id INTEGER PRIMARY KEY);
        CREATE TABLE log(n INTEGER);
        CREATE TRIGGER t AFTER INSERT ON posts FOR EACH ROW BEGIN
          INSERT INTO log VALUES (CASE WHEN NEW.id > 1 THEN 2 ELSE 1 END);
          SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'end of the log') END;
        END;
        INSERT INTO posts VALUES (1), (2);
      `);
      expect(sql.exec("SELECT group_concat(n) AS n FROM log").one().n).toBe("1,2");
    }));
});
