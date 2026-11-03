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
  // A long poll: waits for data until its request's signal aborts (the client went away).
  async fetch(req: Request) {
    await new Promise((r) => req.signal.addEventListener("abort", r, { once: true }));
    this.ctx.storage.sql.exec("INSERT INTO t VALUES (?)", "poll ended");
    return new Response(null, { status: 499 });
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
    worker: {
      Slow,
      default: {
        // /later: answers at once and writes to an object afterwards (ctx.waitUntil), as a
        // queue's delivery does. Otherwise a Worker-level long poll: ends when its request's
        // signal aborts.
        fetch: (req: Request, env: any, ctx: any) =>
          new URL(req.url).pathname === "/later"
            ? (ctx.waitUntil(
                new Promise((r) => setTimeout(r, 50)).then(() =>
                  env.SLOW.getByName("later").write("from waitUntil"),
                ),
              ),
              new Response("accepted"))
            : new Promise<Response>((resolve) =>
                req.signal.addEventListener(
                  "abort",
                  () => resolve(new Response(null, { status: 499 })),
                  {
                    once: true,
                  },
                ),
              ),
      },
    } as never,
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
    // A closed runtime does not open a cell again (its storage may be another runtime's now).
    await expect(stub.rows()).rejects.toThrow(/was closed/);
    await expect((rt.env.SLOW as any).getByName("other").rows()).rejects.toThrow(/was closed/);
  });

  it("aborts the signal of a request in flight: a long poll ends, within the grace period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p34-"));
    const rt = runtime(dir, 5_000);
    const stub = (rt.env.SLOW as any).getByName("c");
    await stub.rows();
    const polled = stub.fetch("http://x/poll");
    await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await rt.close();
    expect(Date.now() - started).toBeLessThan(1_000); // not the 5 s of grace
    expect((await polled).status).toBe(499);

    const again = runtime(dir);
    expect(await (again.env.SLOW as any).getByName("c").rows()).toEqual(["poll ended"]);
    await again.close();
  });

  it("aborts the signal of the Worker's own requests in flight", async () => {
    const rt = runtime(mkdtempSync(join(tmpdir(), "p34-")), 5_000);
    const polled = rt.fetch(new Request("http://x/poll"));
    await new Promise((r) => setTimeout(r, 10));
    const started = Date.now();
    await rt.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await polled).status).toBe(499);
    // and a request after close is refused without running the Worker
    expect((await rt.fetch(new Request("http://x/poll"))).status).toBe(503);
  });

  it("lets work in flight reach other objects during the grace period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p34-"));
    const rt = runtime(dir);
    gate = Promise.resolve();
    expect(await (await rt.fetch(new Request("http://x/later"))).text()).toBe("accepted");
    await rt.close(); // the write is still to come: it opens a cell during the grace period
    const again = runtime(dir);
    expect(await (again.env.SLOW as any).getByName("later").rows()).toEqual(["from waitUntil"]);
    await again.close();
  });
});
