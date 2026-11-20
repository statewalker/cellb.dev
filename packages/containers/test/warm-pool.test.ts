// WarmPool: keeps `size` single-use instances ready; a request takes one (or waits for one), and the
// pool starts a replacement at once. Instances are destroyed after use, never handed out twice.
import { describe, expect, it } from "vitest";
import { WarmPool } from "../src/warm-pool.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function factory(opts: { createMs?: number; failFirst?: number } = {}) {
  let next = 0;
  let failures = opts.failFirst ?? 0;
  const created: number[] = [];
  const destroyed: number[] = [];
  return {
    created,
    destroyed,
    async create() {
      await tick(opts.createMs ?? 5);
      if (failures > 0) {
        failures--;
        throw new Error("create failed");
      }
      const id = ++next;
      created.push(id);
      return { id };
    },
    async destroy(r: { id: number }) {
      destroyed.push(r.id);
    },
  };
}

describe("WarmPool", () => {
  it("fills up to `size` idle instances", async () => {
    const f = factory();
    const pool = new WarmPool(f, { size: 3 });
    await pool.ready();
    expect(pool.idle).toBe(3);
    expect(f.created).toEqual([1, 2, 3]);
    await pool.close();
  });

  it("starts a replacement as soon as an instance is taken", async () => {
    const f = factory({ createMs: 50 });
    const pool = new WarmPool(f, { size: 2 });
    await pool.ready();
    const a = await pool.acquire();
    expect(pool.creating).toBe(1); // already warming the replacement
    await pool.ready();
    expect(pool.idle).toBe(2);
    await pool.destroy(a);
    expect(f.destroyed).toEqual([a.id]);
    await pool.close();
  });

  it("makes requests wait when nothing is ready, and serves them in order", async () => {
    const f = factory({ createMs: 30 });
    const pool = new WarmPool(f, { size: 1 });
    const order: number[] = [];
    const got = await Promise.all(
      [1, 2, 3].map((n) => pool.acquire().then((r) => (order.push(n), r))),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(new Set(got.map((r) => r.id)).size).toBe(3); // never the same instance twice
    await pool.close();
  });

  it("rejects a request that waits longer than its timeout", async () => {
    const f = factory({ createMs: 200 });
    const pool = new WarmPool(f, { size: 1 });
    await expect(pool.acquire({ timeoutMs: 20 })).rejects.toThrow(/timed out/);
    await pool.close();
  });

  it("use() destroys the instance after the work, even when it throws", async () => {
    const f = factory();
    const pool = new WarmPool(f, { size: 1 });
    await expect(pool.use(async (r) => r.id * 10)).resolves.toBe(10);
    await expect(
      pool.use(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await tick(10);
    expect(f.destroyed).toEqual([1, 2]);
    await pool.close();
  });

  it("backs off after failed creates instead of retrying in a loop", async () => {
    const f = factory({ failFirst: 3, createMs: 1 });
    const pool = new WarmPool(f, { size: 1, backoffMs: 40 });
    const started = Date.now();
    const r = await pool.acquire({ timeoutMs: 5_000 });
    // 3 failures with backoff 40, 80, 160 ms before the 4th create succeeds
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(r.id).toBe(1);
    await pool.close();
  });

  it("rejects waiting requests with the cause after `failAfter` failed creates in a row", async () => {
    const f = factory({ failFirst: 1_000, createMs: 1 });
    const pool = new WarmPool(f, { size: 1, backoffMs: 5, failAfter: 3 });
    const r = await pool.acquire({ timeoutMs: 5_000 }).catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/3 failed attempts.*create failed/);
    await pool.close();
  });

  it("starts at most `maxCreating` instances at once", async () => {
    const f = factory({ createMs: 30 });
    const pool = new WarmPool(f, { size: 4, maxCreating: 2 });
    await tick(5);
    expect(pool.creating).toBe(2);
    await pool.ready();
    expect(pool.idle).toBe(4);
    await pool.close();
  });

  it("close() destroys idle instances and rejects waiting requests", async () => {
    const f = factory({ createMs: 100 });
    const pool = new WarmPool(f, { size: 1 });
    const waiting = pool.acquire();
    const first = pool.acquire();
    await pool.close();
    await expect(first).rejects.toThrow(/closed/);
    await expect(waiting).rejects.toThrow(/closed/);
    await tick(150);
    expect(f.destroyed).toEqual(f.created); // instances finished after close are destroyed too
  });
});
