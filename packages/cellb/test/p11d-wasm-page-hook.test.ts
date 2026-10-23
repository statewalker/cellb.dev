import { describe, expect, it } from "vitest";
import { wasmMemoryOpener } from "../src/adapters/wasm-sqlite.js";

// The page hook (src/adapters/wasm-page-hook.ts): the main database file's xWrite is wrapped,
// so a commit's changed pages are known without reading the whole database.
const sqlite = async () =>
  ((await import("@sqlite.org/sqlite-wasm")).default as any)({ print() {}, printErr() {} });

describe("P11d SQLite WASM page hook", () => {
  it("captures exactly the pages a transaction wrote, equal to the database image", async () => {
    const d = wasmMemoryOpener(await sqlite())("cell");
    d.exec("CREATE TABLE t (v TEXT)", []);
    for (let i = 0; i < 300; i++) d.exec("INSERT INTO t VALUES (?)", [`row ${i} `.repeat(20)]);
    d.takeDirtyPages!(); // everything so far
    d.exec("UPDATE t SET v = 'changed' WHERE rowid = 150", []);
    const dirty = d.takeDirtyPages!()!;
    const image = d.snapshot!();
    expect(dirty.pages.size).toBeGreaterThan(0);
    expect(dirty.pages.size).toBeLessThanOrEqual(3); // header page + the row's leaf (+ maybe one)
    expect(dirty.pageCount).toBe(image.length / dirty.pageSize);
    for (const [pgno, bytes] of dirty.pages)
      expect(bytes).toEqual(image.subarray((pgno - 1) * dirty.pageSize, pgno * dirty.pageSize));
  });

  it("a rolled-back transaction's spilled pages are discarded; the hook survives restore()", async () => {
    const d = wasmMemoryOpener(await sqlite())("cell2");
    d.exec("CREATE TABLE t (v TEXT)", []);
    d.takeDirtyPages!();
    d.exec("BEGIN", []);
    d.exec("INSERT INTO t VALUES ('x')", []);
    d.exec("ROLLBACK", []);
    d.discardDirtyPages!();
    expect(d.takeDirtyPages!()!.pages.size).toBe(0);
    d.restore!(d.snapshot!());
    d.exec("INSERT INTO t VALUES ('after restore')", []);
    expect(d.takeDirtyPages!()!.pages.size).toBeGreaterThan(0);
  });

  it("node:sqlite with pageCapture reads a commit's pages from the WAL, equal to the database", async () => {
    const { nodeSqliteOpener } = await import("../src/adapters/node-sqlite.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = nodeSqliteOpener(mkdtempSync(join(tmpdir(), "walcap-")), { pageCapture: true })(
      "cell",
    );
    d.exec("CREATE TABLE t (v TEXT)", []);
    for (let i = 0; i < 300; i++) d.exec("INSERT INTO t VALUES (?)", [`row ${i} `.repeat(20)]);
    d.takeDirtyPages!();
    d.exec("UPDATE t SET v = 'changed' WHERE rowid = 150", []);
    const dirty = d.takeDirtyPages!()!;
    const image = d.pageImage!();
    expect(dirty.pages.size).toBeGreaterThan(0);
    expect(dirty.pages.size).toBeLessThanOrEqual(3);
    expect(dirty.pageCount).toBe(image.length / dirty.pageSize);
    for (const [pgno, bytes] of dirty.pages)
      expect(bytes).toEqual(image.subarray((pgno - 1) * dirty.pageSize, pgno * dirty.pageSize));
    // after the checkpoint pageImage() made, capture continues from the new WAL
    d.exec("INSERT INTO t VALUES ('after checkpoint')", []);
    expect(d.takeDirtyPages!()!.pages.size).toBeGreaterThan(0);
  });
});
