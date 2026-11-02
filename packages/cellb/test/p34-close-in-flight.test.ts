import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCellRuntime } from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";

// An object whose RPC writes after an await the test controls (a model's answer, say).
let gate: Promise<void> = Promise.resolve();
const caught: unknown[] = [];
class Slow {
  constructor(private ctx: any) {
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  }
  async write(v: string) {
    await gate;
    try {
      this.ctx.storage.sql.exec("INSERT INTO t VALUES (?)", v);
    } catch (e) {
      caught.push(e);
      throw e;
    }
    return v;
  }
  rows() {
    return this.ctx.storage.sql
      .exec("SELECT v FROM t ORDER BY v")
      .toArray()
      .map((r: any) => r.v);
  }
}

const runtime = (dir: string, closeGraceMs?: number) =>
  createCellRuntime({
    worker: { Slow, default: { fetch: () => new Response("") } } as never,
    durableObjects: { SLOW: { className: "Slow" } },
    openSql: nodeSqliteOpener(dir),
    closeGraceMs,
  });

// The runtime's close() met events still running (Flue's conversations in a browser shard, when
// a test closed the app): their next statement failed with SQLite's "DB has been closed".
describe("P34 close() with events in flight", () => {
  it("lets an event in flight finish and keep its write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p34-"));
    const rt = runtime(dir);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const stub = (rt.env.SLOW as any).getByName("a");
    await stub.rows(); // the object is open
    const written = stub.write("x");
    await new Promise((r) => setTimeout(r, 10)); // the call is in flight
    const closed = rt.close();
    setTimeout(open, 50);
    await expect(written).resolves.toBe("x");
    await closed;

    const again = runtime(dir);
    expect(await (again.env.SLOW as any).getByName("a").rows()).toEqual(["x"]);
    await again.close();
  });

  it("past the grace period, closes; storage used later fails with ObjectClosedError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p34-"));
    const rt = runtime(dir, 30);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    caught.length = 0;
    const stub = (rt.env.SLOW as any).getByName("b");
    await stub.rows();
    const written = stub.write("late");
    written.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    await rt.close(); // does not wait for the gate
    open();
    await expect(written).rejects.toThrow();
    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).name).toBe("ObjectClosedError");
    expect((caught[0] as Error).message).toMatch(/Slow\/[0-9a-f]+ was closed/);
  });
});
