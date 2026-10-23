import { describe, expect, it } from "vitest";
import { BrokenObjectError, runInDurableObject } from "../src/index.js";
import { Probe, probeRuntime } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("P03 input gate", () => {
  it("serializes read-modify-write over async storage (the classic counter race)", async () => {
    const { ns } = probeRuntime();
    const stub = ns.getByName("rmw");
    const incr = () =>
      runInDurableObject(stub, async (_o, ctx) => {
        const v = ((await ctx.storage.get<number>("n")) ?? 0) + 1;
        await ctx.storage.put("n", v);
        return v;
      });
    const results = await Promise.all(Array.from({ length: 50 }, incr));
    expect(new Set(results).size).toBe(50);
    expect(await runInDurableObject(stub, (_o, ctx) => ctx.storage.get("n"))).toBe(50);
  });

  it("does NOT protect across non-storage I/O (same as Cloudflare): lost updates are possible", async () => {
    const { ns } = probeRuntime();
    const stub = ns.getByName("io");
    const incr = () =>
      runInDurableObject(stub, async (_o, ctx) => {
        const v = ((await ctx.storage.get<number>("n")) ?? 0) + 1;
        await sleep(5); // external I/O opens the gate
        await ctx.storage.put("n", v);
      });
    await Promise.all(Array.from({ length: 10 }, incr));
    expect(await runInDurableObject(stub, (_o, ctx) => ctx.storage.get("n"))).toBeLessThan(10);
  });

  it("blockConcurrencyWhile in the constructor delays every event until init completes", async () => {
    const order: string[] = [];
    Probe.init = async (ctx) => {
      await sleep(20);
      ctx.storage.kv.put("ready", true);
      order.push("init");
    };
    try {
      const { ns } = probeRuntime();
      const stub = ns.getByName("bcw");
      const seen = await Promise.all(
        [1, 2].map((i) =>
          runInDurableObject(stub, (_o, ctx) => {
            order.push(`event${i}`);
            return ctx.storage.kv.get("ready");
          }),
        ),
      );
      expect(seen).toEqual([true, true]);
      expect(order[0]).toBe("init");
    } finally {
      Probe.init = undefined;
    }
  });

  it("blockConcurrencyWhile nests 64 deep; the 65th throws at once (as workerd and celld)", async () => {
    const { ns } = probeRuntime();
    const probe = (depth: number) =>
      runInDurableObject(ns.getByName(`depth-${depth}`), (_o, ctx) => {
        const enter = async (n: number): Promise<string> => {
          if (n > 0) return ctx.blockConcurrencyWhile(() => enter(n - 1));
          try {
            return await ctx.blockConcurrencyWhile(async () => "ok");
          } catch (e) {
            return (e as Error).message;
          }
        };
        return enter(depth);
      });
    expect(await probe(63)).toBe("ok");
    expect(await probe(64)).toBe("blockConcurrencyWhile() calls are nested too deeply.");
  });
});

describe("P03 failing blockConcurrencyWhile", () => {
  it("resets the object: queued events reject with the cause, the next call builds a fresh instance", async () => {
    let fail = true;
    Probe.init = async () => {
      await sleep(10);
      if (fail) throw new Error("database is locked");
    };
    try {
      const { ns } = probeRuntime();
      const stub = ns.getByName("bcw-fail");
      const before = Probe.constructed;
      const r = await Promise.allSettled([1, 2].map(() => runInDurableObject(stub, () => "ran")));
      expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
      expect(String((r[0] as PromiseRejectedResult).reason.message)).toMatch(
        /initialization failed: database is locked/,
      );
      fail = false;
      expect(await runInDurableObject(stub, () => "ran")).toBe("ran");
      expect(Probe.constructed).toBe(before + 2);
    } finally {
      Probe.init = undefined;
    }
  });
});

describe("P03 output gate", () => {
  it("holds the result until the commit is durable", async () => {
    let durableAt = 0;
    const { ns } = probeRuntime({
      durability: {
        committed: async () => {
          await sleep(30);
          durableAt = Date.now();
        },
      },
    });
    const t0 = Date.now();
    await runInDurableObject(ns.getByName("og"), (_o, ctx) => {
      ctx.storage.kv.put("x", 1);
    });
    const deliveredAt = Date.now();
    expect(durableAt).toBeGreaterThan(0);
    expect(deliveredAt).toBeGreaterThanOrEqual(durableAt);
    expect(deliveredAt - t0).toBeGreaterThanOrEqual(25);
  });

  it("read-only events are not delayed by durability", async () => {
    let calls = 0;
    const { ns } = probeRuntime({
      durability: {
        committed: async () => {
          calls++;
          await sleep(50);
        },
      },
    });
    const stub = ns.getByName("ro");
    const t0 = Date.now();
    await runInDurableObject(stub, () => 42);
    expect(Date.now() - t0).toBeLessThan(40);
    expect(calls).toBe(0);
  });

  it("coalesces the sync writes of one event into ONE commit", async () => {
    const seqs: number[] = [];
    const { ns } = probeRuntime({
      durability: { committed: async (_k, { seq }) => void seqs.push(seq) },
    });
    await runInDurableObject(ns.getByName("co"), (_o, ctx) => {
      ctx.storage.sql.exec("CREATE TABLE t (x)");
      for (let i = 0; i < 100; i++) ctx.storage.sql.exec("INSERT INTO t VALUES (?)", i);
      ctx.storage.kv.put("done", true);
    });
    expect(seqs).toEqual([1]);
  });

  it("a failed durable commit breaks the object: caller gets an error, next call gets a fresh instance", async () => {
    let fail = true;
    const { ns } = probeRuntime({
      durability: {
        committed: async () => {
          if (fail) throw new Error("replica unreachable");
        },
      },
    });
    const stub = ns.getByName("broken");
    await runInDurableObject(stub, () => 0); // instantiate
    const before = Probe.constructed;
    await expect(
      runInDurableObject(stub, (_o, ctx) => {
        ctx.storage.kv.put("x", 1);
      }),
    ).rejects.toBeInstanceOf(BrokenObjectError);
    fail = false;
    await runInDurableObject(stub, () => 1);
    expect(Probe.constructed).toBe(before + 1);
  });

  it("ctx.storage.sync() waits for durability of previous writes", async () => {
    let durable = false;
    const { ns } = probeRuntime({
      durability: {
        committed: async () => {
          await sleep(20);
          durable = true;
        },
      },
    });
    const seen = await runInDurableObject(ns.getByName("sy"), async (_o, ctx) => {
      ctx.storage.kv.put("x", 1);
      await ctx.storage.sync();
      return durable;
    });
    expect(seen).toBe(true);
  });
});
