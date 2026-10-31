import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../src/adapters/node-sqlite.js";
import { SqlStorage } from "../src/core/sql-storage.js";
import type { SyncSqlDriver } from "../src/ports.js";

/**
 * A driver whose next statement fails as SQLite does after an I/O error on a read (an LTX VFS
 * read past the quota, say): SQLite rolls the whole transaction back by itself, then reports.
 */
function failingDriver() {
  const inner = new NodeSqliteDriver();
  let failNext = false;
  const driver: SyncSqlDriver = Object.assign(Object.create(inner), {
    exec(sql: string, params: unknown[]) {
      if (failNext) {
        failNext = false;
        inner.exec("ROLLBACK", []);
        throw new Error("SQLITE_IOERR: sqlite3 result code 10: disk I/O error");
      }
      return inner.exec(sql, params);
    },
  });
  return { driver, failNext: () => (failNext = true), inner };
}

// A statement's I/O error fails the request; it breaks the Durable Object (its commit throws)
// only when the transaction SQLite rolled back had written.
describe("P33 a statement's I/O error after SQLite's own rollback", () => {
  it("in a read-only transaction: the statement fails, the storage goes on", () => {
    const { driver, failNext } = failingDriver();
    const sql = new SqlStorage(driver, () => {});
    sql.exec("CREATE TABLE t (v INTEGER)");
    sql.commit();
    sql.exec("SELECT * FROM t");
    failNext();
    expect(() => sql.exec("SELECT * FROM t")).toThrow(/disk I\/O error/);
    expect(() => sql.commit()).not.toThrow(); // before: "cannot commit - no transaction is active"
    sql.exec("INSERT INTO t VALUES (1)");
    sql.commit();
    expect(sql.exec("SELECT v FROM t").toArray()).toEqual([{ v: 1 }]);
  });

  it("in a transaction that had written: its commit reports the lost writes and why", () => {
    const { driver, failNext } = failingDriver();
    const sql = new SqlStorage(driver, () => {});
    sql.exec("CREATE TABLE t (v INTEGER)");
    sql.commit();
    sql.exec("INSERT INTO t VALUES (1)");
    failNext();
    expect(() => sql.exec("SELECT * FROM t")).toThrow(/disk I\/O error/);
    expect(() => sql.commit()).toThrow(/rolled back after: disk I\/O error/);
    expect(sql.exec("SELECT count(*) AS n FROM t").toArray()).toEqual([{ n: 0 }]);
    sql.exec("INSERT INTO t VALUES (2)");
    sql.commit();
    expect(sql.exec("SELECT v FROM t").toArray()).toEqual([{ v: 2 }]);
  });

  it("inside transactionSync: the I/O error itself, not a missing savepoint", () => {
    const { driver, failNext } = failingDriver();
    const sql = new SqlStorage(driver, () => {});
    sql.exec("CREATE TABLE t (v INTEGER)");
    sql.commit();
    expect(() =>
      sql.transactionSync(() => {
        sql.exec("INSERT INTO t VALUES (1)");
        failNext();
        sql.exec("SELECT * FROM t");
      }),
    ).toThrow(/disk I\/O error/);
    expect(() => sql.commit()).toThrow(/rolled back/);
  });
});
