import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../src/adapters/node-sqlite.js";
import { type OpenCellSql, wasmMemoryOpener } from "../src/index.js";
import { sqliteObjectStore } from "../src/node.js";
import type { SyncSqlDriver } from "../src/ports.js";

/**
 * A zero-length BLOB is stored as a BLOB, not as NULL, as on workerd. node:sqlite (Node 22)
 * binds a view whose buffer has no backing store (`new ArrayBuffer(0)`) as NULL: a format that
 * tells "empty" from "absent" by NULL (sqlar: a directory) would read an empty file as missing.
 */
const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
const drivers: [string, () => Promise<SyncSqlDriver>][] = [
  ["node:sqlite", async () => new NodeSqliteDriver()],
  [
    "sqlite-wasm",
    async () => (wasmMemoryOpener(sqlite3) as OpenCellSql)(`p48-${Math.random()}`) as never,
  ],
];
const empties: [string, () => unknown][] = [
  ["ArrayBuffer(0)", () => new ArrayBuffer(0)],
  ["Uint8Array over ArrayBuffer(0)", () => new Uint8Array(new ArrayBuffer(0))],
  ["Uint8Array(0)", () => new Uint8Array(0)],
  ["an empty subarray", () => new Uint8Array(8).subarray(3, 3)],
];

describe.each(drivers)("p48 empty BLOBs stay BLOBs [%s]", (_n, open) => {
  for (const [name, value] of empties)
    it(`binds ${name} as an empty BLOB`, async () => {
      const d = await open();
      d.exec("CREATE TABLE t (x)", []);
      d.exec("INSERT INTO t VALUES (?)", [value()]);
      const [type, len] = d.exec("SELECT typeof(x), length(x) FROM t", []).rows[0];
      expect([type, Number(len)]).toEqual(["blob", 0]);
      const back = d.exec("SELECT x FROM t", []).rows[0][0];
      expect(back).toBeInstanceOf(ArrayBuffer);
      expect((back as ArrayBuffer).byteLength).toBe(0);
    });

  it("still binds null as NULL and a non-empty view by its bytes only", async () => {
    const d = await open();
    d.exec("CREATE TABLE t (x)", []);
    d.exec("INSERT INTO t VALUES (?), (?)", [null, new Uint8Array([9, 1, 2, 9]).subarray(1, 3)]);
    const rows = d.exec("SELECT typeof(x), hex(x) FROM t ORDER BY rowid", []).rows;
    expect(rows).toEqual([
      ["null", ""],
      ["blob", "0102"],
    ]);
  });
});

describe("p48 an empty object in the sqlite object store (celld dev's bucket)", () => {
  for (const [name, value] of empties.filter(([n]) => n !== "ArrayBuffer(0)"))
    it(`stores ${name} as an empty body`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cellb-p48-"));
      const store = sqliteObjectStore(join(dir, "objects.sqlite3"));
      try {
        await store.put("k", value() as Uint8Array);
        const got = await store.get("k");
        expect(got?.body.byteLength).toBe(0);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
