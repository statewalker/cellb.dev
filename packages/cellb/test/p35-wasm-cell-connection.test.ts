import { describe, expect, it } from "vitest";
import { wasmMemoryOpener } from "../src/index.js";

// tuneCellConnection (src/adapters/wasm-sqlite.ts): a cell's SQLite WASM connection has no
// lookaside and a new database gets 4 KiB pages, celld's page size, so that many cells fit in
// one worker's heap (at most 2 GiB). A database that already holds data keeps its page size.
const sqlite = async () =>
  ((await import("@sqlite.org/sqlite-wasm")).default as any)({ print() {}, printErr() {} });

describe("P35 cell connections in SQLite WASM", () => {
  it("a new cell database has 4 KiB pages", async () => {
    const d = wasmMemoryOpener(await sqlite())("cell");
    d.exec("CREATE TABLE t (v TEXT)", []);
    d.exec("INSERT INTO t VALUES ('x')", []);
    expect(d.exec("PRAGMA page_size", []).rows[0][0]).toBe(4096);
  });

  it("a restored image keeps its own page size", async () => {
    const s = await sqlite();
    const src = new s.oo1.DB("file:/src?vfs=memdb", "c");
    src.exec("PRAGMA page_size=8192; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    const image = s.capi.sqlite3_js_db_export(src);
    const d = wasmMemoryOpener(s)("cell");
    d.restore!(image);
    expect(d.exec("PRAGMA page_size", []).rows[0][0]).toBe(8192);
    expect(d.exec("SELECT v FROM t", []).rows[0][0]).toBe("kept");
  });

  it("a thousand cells take at most half the memory of SQLite WASM's defaults", async () => {
    const heapGrowth = async (
      open: (s: any, i: number) => { exec(sql: string, p: unknown[]): unknown },
    ) => {
      const s = await sqlite();
      const before = s.wasm.heap8u().byteLength;
      const kept = [];
      for (let i = 0; i < 1_000; i++) {
        const d = open(s, i);
        d.exec("CREATE TABLE t (v TEXT)", []);
        d.exec("INSERT INTO t VALUES ('x')", []);
        kept.push(d);
      }
      return s.wasm.heap8u().byteLength - before;
    };
    const tuned = await heapGrowth((s) => wasmMemoryOpener(s)("cell"));
    const defaults = await heapGrowth((s, i) => {
      const db = new s.oo1.DB(`file:/d${i}?vfs=memdb`, "c");
      return { exec: (sql: string) => db.exec(sql) };
    });
    expect(tuned).toBeLessThan(defaults / 2 + 2 ** 20);
  });
});
