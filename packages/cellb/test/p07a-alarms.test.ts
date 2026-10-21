import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime, DurableObject, runInDurableObject } from "../src/index.js";
import { FakeClock } from "./fake-clock.js";

/** Records every alarm() call; fails while `failures` > 0; can re-arm itself. */
class Sleeper extends DurableObject {
  static calls: { name: string; retryCount: number; isRetry: boolean; seenAlarm: number | null }[] = [];
  static failures = 0;
  static rearmMs = 0;
  static lastAt = 0;
  async alarm(info: { retryCount: number; isRetry: boolean }) {
    const name = (await this.ctx.storage.get<string>("name")) ?? "?";
    Sleeper.calls.push({ name, ...info, seenAlarm: await this.ctx.storage.getAlarm() });
    if (Sleeper.failures > 0) {
      Sleeper.failures--;
      throw new Error("alarm handler failed");
    }
    // Relative to the previous alarm time: the test clock is virtual.
    if (Sleeper.rearmMs) {
      Sleeper.lastAt += Sleeper.rearmMs;
      await this.ctx.storage.setAlarm(Sleeper.lastAt);
    }
  }
}

const setup = (opts: { dir?: string; clock?: FakeClock } = {}) => {
  const clock = opts.clock ?? new FakeClock(Date.now());
  const rt = createCellRuntime({
    worker: { Sleeper, default: {} },
    durableObjects: { SLEEPER: { className: "Sleeper" } },
    openSql: nodeSqliteOpener(opts.dir),
    clock,
  });
  const stub = (n: string) => (rt.env.SLEEPER as any).getByName(n);
  const arm = (n: string, inMs: number) =>
    runInDurableObject(stub(n), async (_o, ctx) => {
      await ctx.storage.put("name", n);
      await ctx.storage.setAlarm(clock.now() + inMs);
      return ctx.storage.getAlarm();
    });
  return { rt, clock, stub, arm };
};
const reset = () => {
  Sleeper.calls = [];
  Sleeper.failures = 0;
  Sleeper.rearmMs = 0;
};

describe("P07a Durable Object alarms", () => {
  it("setAlarm / getAlarm / deleteAlarm; Date and number; one alarm per object", async () => {
    reset();
    const { clock, stub, arm } = setup();
    expect(await arm("a", 5_000)).toBe(clock.now() + 5_000);
    const r = await runInDurableObject(stub("a"), async (_o, ctx) => {
      await ctx.storage.setAlarm(new Date(clock.now() + 9_000)); // replaces the first
      const replaced = await ctx.storage.getAlarm();
      await ctx.storage.deleteAlarm();
      return { replaced, after: await ctx.storage.getAlarm() };
    });
    expect(r).toEqual({ replaced: clock.now() + 9_000, after: null });
    await clock.advance(10_000);
    expect(Sleeper.calls).toEqual([]);
  });

  it("fires once at the due time with retryCount 0; getAlarm() inside the handler is null", async () => {
    reset();
    const { clock, arm } = setup();
    await arm("b", 2_000);
    await clock.advance(1_999);
    expect(Sleeper.calls).toEqual([]);
    await clock.advance(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(Sleeper.calls).toEqual([{ name: "b", retryCount: 0, isRetry: false, seenAlarm: null }]);
    await clock.advance(60_000);
    expect(Sleeper.calls).toHaveLength(1);
  });

  it("a handler can re-arm itself", async () => {
    reset();
    Sleeper.rearmMs = 1_000;
    const { clock, arm } = setup();
    Sleeper.lastAt = clock.now() + 1_000;
    await arm("c", 1_000);
    for (let i = 0; i < 3; i++) {
      await clock.advance(1_000);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(Sleeper.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a throwing handler is retried with exponential backoff (2 s, 4 s, …) and retryCount", async () => {
    reset();
    Sleeper.failures = 2;
    const { clock, arm } = setup();
    await arm("d", 1_000);
    await clock.advance(1_000);
    await new Promise((r) => setTimeout(r, 20));
    await clock.advance(2_000);
    await new Promise((r) => setTimeout(r, 20));
    await clock.advance(4_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(Sleeper.calls.map((c) => [c.retryCount, c.isRetry])).toEqual([
      [0, false],
      [1, true],
      [2, true],
    ]);
  });

  it("deleteAll() deletes the alarm", async () => {
    reset();
    const { clock, stub, arm } = setup();
    await arm("e", 1_000);
    await runInDurableObject(stub("e"), (_o, ctx) => ctx.storage.deleteAll());
    await clock.advance(5_000);
    expect(Sleeper.calls).toEqual([]);
  });

  it("catch-up: a NEW runtime on the same storage fires an overdue alarm without any request", async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), "cells-alarms-"));
    const clock = new FakeClock(Date.now());
    const first = setup({ dir, clock });
    await first.arm("f", 3_000);
    first.rt.evictAll(); // the process/tab goes away before the alarm is due
    await clock.advance(10_000); // ... and comes back later
    setup({ dir, clock }); // restart: nobody touches the object
    await clock.advance(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(Sleeper.calls.map((c) => c.name)).toEqual(["f"]);
  });
});
