import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime } from "../src/index.js";
import { simulatorFetcher } from "../src/miniflare-compat/simulator-fetcher.js";
// @ts-expect-error — generated JS bundles (scripts/vendor-miniflare.mjs), no .d.ts
import makeD1Binding from "../vendor/miniflare/d1-api.js";
// @ts-expect-error — generated JS bundle
import { D1DatabaseObject } from "../vendor/miniflare/d1-database.js";

// Hypothesis: a complete D1 binding needs NO new code — workerd's own TypeScript client
// (src/cloudflare/internal/d1-api.ts) talks to Miniflare's D1 simulator object, both
// unchanged, with the simulator running on webrun-cells' synchronous SQLite.
function setup() {
  const rt = createCellRuntime({
    worker: { D1DatabaseObject, default: {} },
    durableObjects: { D1_OBJECTS: { className: "D1DatabaseObject" } },
    openSql: nodeSqliteOpener(),
  });
  return makeD1Binding({ fetcher: simulatorFetcher(rt.env.D1_OBJECTS as never, "db-main") });
}

describe("P08b D1 = workerd's d1-api.ts client + Miniflare's D1 simulator, both unchanged", () => {
  it("exec, prepare/bind/run, all, first, raw", async () => {
    const db = setup();
    await db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
    const ins = await db
      .prepare("INSERT INTO users (name, age) VALUES (?, ?)")
      .bind("ada", 36)
      .run();
    expect(ins.success).toBe(true);
    expect(ins.meta.changes).toBe(1);
    await db.prepare("INSERT INTO users (name, age) VALUES (?1, ?2)").bind("alan", 41).run();
    const all = await db.prepare("SELECT name, age FROM users ORDER BY id").all();
    expect(all.results).toEqual([
      { name: "ada", age: 36 },
      { name: "alan", age: 41 },
    ]);
    expect(await db.prepare("SELECT name FROM users WHERE age > ?").bind(40).first("name")).toBe(
      "alan",
    );
    expect(await db.prepare("SELECT name, age FROM users ORDER BY id").raw()).toEqual([
      ["ada", 36],
      ["alan", 41],
    ]);
  });

  it("batch runs atomically: a failing statement rolls back the whole batch", async () => {
    const db = setup();
    await db.exec("CREATE TABLE t (x INTEGER UNIQUE)");
    const stmt = db.prepare("INSERT INTO t VALUES (?)");
    const ok = await db.batch([stmt.bind(1), stmt.bind(2)]);
    expect(ok.map((r: { success: boolean }) => r.success)).toEqual([true, true]);
    await expect(db.batch([stmt.bind(3), stmt.bind(1)])).rejects.toThrow(/UNIQUE/);
    expect((await db.prepare("SELECT x FROM t ORDER BY x").raw()).flat()).toEqual([1, 2]);
  });

  it("errors carry D1's messages; BLOBs round-trip", async () => {
    const db = setup();
    await expect(db.prepare("SELEC nope").all()).rejects.toThrow(/D1_ERROR|syntax/i);
    await db.exec("CREATE TABLE b (data BLOB)");
    await db
      .prepare("INSERT INTO b VALUES (?)")
      .bind(new Uint8Array([1, 2, 3]))
      .run();
    const row = await db.prepare("SELECT data FROM b").first<{ data: number[] }>();
    expect(row?.data).toEqual([1, 2, 3]);
  });
});
