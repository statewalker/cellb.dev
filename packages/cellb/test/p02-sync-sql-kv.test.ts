import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { NodeSqliteDriver, nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";
import type { OpenCellSql } from "../src/index.js";
import { probeRuntime as baseProbeRuntime } from "./helpers.js";

// P04a: the same storage suite runs against every SyncSqlDriver.
const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
const drivers: [string, () => OpenCellSql][] = [
  ["node:sqlite", () => nodeSqliteOpener()],
  ["sqlite-wasm (oo1)", () => wasmMemoryOpener(sqlite3 as any)],
];

describe.each(drivers)("P02 [%s]", (_name, opener) => {
  const probeRuntime = (o: Parameters<typeof baseProbeRuntime>[0] = {}) =>
    baseProbeRuntime({ openSql: opener(), ...o });
  describe("synchronous SQL (ctx.storage.sql)", () => {
    it("exec returns a CF-shaped cursor: toArray / one / raw / columnNames / rowsWritten", async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("s", (ctx) => {
        const { sql } = ctx.storage;
        sql.exec("CREATE TABLE t (a INTEGER, b TEXT, c BLOB)");
        const ins = sql.exec(
          "INSERT INTO t VALUES (?, ?, ?), (?, ?, ?)",
          1,
          "x",
          new Uint8Array([1, 2]).buffer,
          2,
          "y",
          null,
        );
        const c = sql.exec("SELECT a, b, c FROM t ORDER BY a");
        return {
          written: ins.rowsWritten,
          cols: c.columnNames,
          rows: c.toArray(),
          one: sql.exec("SELECT count(*) AS n FROM t").one(),
          raw: [...sql.exec("SELECT a FROM t ORDER BY a").raw()],
          end: Object.keys(sql.exec("SELECT 1 WHERE 0").next()), // as workerd: no `value` key
        };
      });
      expect(r.written).toBe(2);
      expect(r.cols).toEqual(["a", "b", "c"]);
      expect(r.rows[0].c).toBeInstanceOf(ArrayBuffer); // BLOBs come back as ArrayBuffer like workerd
      expect(new Uint8Array(r.rows[0].c as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));
      expect(r.one).toEqual({ n: 2 });
      expect(r.raw).toEqual([[1], [2]]);
      expect(r.end).toEqual(["done"]);
    });

    it("one() throws on zero or many rows; multi-statement scripts run without bindings", async () => {
      const { inObject } = probeRuntime();
      await inObject("m", (ctx) => {
        ctx.storage.sql.exec(
          "CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO a VALUES (1); INSERT INTO a VALUES (2);",
        );
        expect(() => ctx.storage.sql.exec("SELECT * FROM b").one()).toThrow(/no results/);
        expect(() => ctx.storage.sql.exec("SELECT * FROM a").one()).toThrow(/multiple/);
      });
    });

    it('a double-quoted name that is no column is a string ("foo"), as on celld and workerd', async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("q", (ctx) => {
        ctx.storage.sql.exec("CREATE TABLE t (foo TEXT); INSERT INTO t VALUES ('column')");
        return {
          literal: ctx.storage.sql.exec('SELECT "bar" AS v').one(),
          column: ctx.storage.sql.exec('SELECT "foo" AS v FROM t').one(),
        };
      });
      expect(r).toEqual({ literal: { v: "bar" }, column: { v: "column" } });
    });

    it("rejects SQL-level transactions and access to internal _cf_ tables", async () => {
      const { inObject } = probeRuntime();
      await inObject("g", (ctx) => {
        // celld's wording (conformance/projects/storage-details)
        expect(() => ctx.storage.sql.exec("BEGIN")).toThrow(
          "SQL error: prepare SQL cursor: not authorized",
        );
        expect(() => ctx.storage.sql.exec("SAVEPOINT x")).toThrow(/not authorized/);
        ctx.storage.kv.put("k", 1);
        expect(() => ctx.storage.sql.exec("SELECT * FROM _cf_KV")).toThrow(
          /access to _cf_KV\.scope is prohibited/,
        );
      });
    });

    it("transactionSync rolls back on throw and nests", async () => {
      const { inObject } = probeRuntime();
      const rows = await inObject("t", (ctx) => {
        const { sql } = ctx.storage;
        sql.exec("CREATE TABLE t (x)");
        ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO t VALUES (1)");
          expect(() =>
            ctx.storage.transactionSync(() => {
              sql.exec("INSERT INTO t VALUES (2)");
              throw new Error("inner");
            }),
          ).toThrow("inner");
          sql.exec("INSERT INTO t VALUES (3)");
        });
        return sql
          .exec("SELECT x FROM t ORDER BY x")
          .toArray()
          .map((r: any) => r.x);
      });
      expect(rows).toEqual([1, 3]);
    });

    it("reports databaseSize", async () => {
      const { inObject } = probeRuntime();
      const size = await inObject("z", (ctx) => {
        ctx.storage.sql.exec("CREATE TABLE t (x)");
        return ctx.storage.sql.databaseSize;
      });
      expect(size).toBeGreaterThan(0);
    });
  });

  describe("KV over SQL (ctx.storage.kv sync + ctx.storage async)", () => {
    it("sync kv: get/put/delete/list with range options, UTF-8 byte order", async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("k", (ctx) => {
        const kv = ctx.storage.kv;
        for (const k of ["a", "b1", "b2", "b3", "c", "é"]) kv.put(k, k.toUpperCase());
        return {
          get: kv.get("b2"),
          missing: kv.get("zz"),
          del: [kv.delete("c"), kv.delete("c")],
          prefix: [...kv.list({ prefix: "b" })].map(([k]) => k),
          range: [...kv.list({ start: "b1", end: "b3" })].map(([k]) => k),
          after: [...kv.list({ startAfter: "b1", limit: 2 })].map(([k]) => k),
          reverse: [...kv.list({ reverse: true, limit: 2 })].map(([k]) => k),
        };
      });
      expect(r.get).toBe("B2");
      expect(r.missing).toBeUndefined();
      expect(r.del).toEqual([true, false]);
      expect(r.prefix).toEqual(["b1", "b2", "b3"]);
      expect(r.range).toEqual(["b1", "b2"]);
      expect(r.after).toEqual(["b2", "b3"]);
      expect(r.reverse).toEqual(["é", "b3"]);
    });

    it("values round-trip structured-clone types", async () => {
      const { inObject } = probeRuntime();
      const v = {
        d: new Date(1700000000000),
        m: new Map([["x", 1]]),
        s: new Set([1, 2]),
        n: 10n,
        u8: new Uint8Array([9, 8]),
        ab: new Uint8Array([7]).buffer,
        nested: { $t: "not a tag" },
        arr: [1, undefined],
      };
      const back = await inObject("v", async (ctx) => {
        await ctx.storage.put("v", v);
        return ctx.storage.get<any>("v");
      });
      expect(back).toEqual(v);
    });

    it("async API: multi-key get/put/delete, list → Map, no key-count limit (as celld)", async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("a", async (ctx) => {
        await ctx.storage.put({ x: 1, y: 2, z: 3 });
        const many = await ctx.storage.get(["z", "x", "nope"]);
        const deleted = await ctx.storage.delete(["x", "y", "nope"]);
        const listed = await ctx.storage.list();
        let limitErr = "";
        await ctx.storage
          .get(Array.from({ length: 129 }, (_, i) => `k${i}`))
          .catch((e) => (limitErr = e.message));
        return { many: [...many], deleted, listed: [...listed], limitErr };
      });
      expect(r.many).toEqual([
        ["x", 1],
        ["z", 3],
      ]);
      expect(r.deleted).toBe(2);
      expect(r.listed).toEqual([["z", 3]]);
      expect(r.limitErr).toBe(""); // Cloudflare caps at 128 keys; celld does not
    });

    it("async transaction(): commits, explicit rollback(), rollback on throw", async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("tx", async (ctx) => {
        await ctx.storage.transaction(async (txn) => {
          await txn.put("a", 1);
        });
        await ctx.storage.transaction(async (txn) => {
          await txn.put("b", 1);
          txn.rollback();
        });
        await ctx.storage
          .transaction(async (txn) => {
            await txn.put("c", 1);
            throw new Error("x");
          })
          .catch(() => {});
        return [...(await ctx.storage.list()).keys()];
      });
      expect(r).toEqual(["a"]);
    });

    it("deleteAll wipes KV and user tables", async () => {
      const { inObject } = probeRuntime();
      const r = await inObject("da", async (ctx) => {
        ctx.storage.sql.exec("CREATE TABLE t (x)");
        await ctx.storage.put("k", 1);
        await ctx.storage.deleteAll();
        const tables = ctx.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='t'")
          .toArray();
        return { k: await ctx.storage.get("k"), tables };
      });
      expect(r).toEqual({ k: undefined, tables: [] });
    });
  });
});

describe("P02 implicit transaction (node:sqlite file, observed from a 2nd connection)", () => {
  it("implicit transaction: sync writes become visible to other connections only after the handler yields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-"));
    const { inObject } = baseProbeRuntime({ openSql: nodeSqliteOpener(dir) });
    const seen = await inObject("i", async (ctx) => {
      const file = join(dir, `Probe_${ctx.id.toString()}.sqlite`);
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (x)");
      await Promise.resolve(); // commit schema
      const spy = new NodeSqliteDriver(file);
      ctx.storage.sql.exec("INSERT INTO t VALUES (1)");
      ctx.storage.sql.exec("INSERT INTO t VALUES (2)");
      const before = spy.exec("SELECT count(*) AS n FROM t", []).rows[0][0];
      await Promise.resolve(); // yield → implicit COMMIT
      const after = spy.exec("SELECT count(*) AS n FROM t", []).rows[0][0];
      spy.close();
      return { before, after };
    });
    expect(seen).toEqual({ before: 0, after: 2 });
  });
});
