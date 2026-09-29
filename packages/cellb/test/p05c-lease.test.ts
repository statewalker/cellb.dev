import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteConditionalStore, SqliteFileLease } from "../src/adapters/sqlite-lease.js";
import {
  CasLease,
  type ConditionalStore,
  FencedError,
  FencedManifest,
  MemoryConditionalStore,
} from "../src/index.js";
import { FakeClock } from "./fake-clock.js";

describe("P05c single-host lease: SQLite file in EXCLUSIVE locking mode (OS lock)", () => {
  let holder = "";
  const dir = mkdtempSync(join(tmpdir(), "cells-lease-"));
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    holder = join(dir, "lease-holder.mjs");
    await build({
      entryPoints: [join(__dirname, "lease-holder.entry.ts")],
      outfile: holder,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    });
  });
  afterAll(() => {
    for (const c of children) c.kill("SIGKILL");
  });
  const child = (name: string, mode = "hold") =>
    new Promise<{ proc: ChildProcess; msg: any }>((resolve) => {
      const proc = fork(holder, [join(dir, "locks"), name, mode], { execArgv: ["--no-warnings"] });
      children.push(proc);
      proc.once("message", (msg) => resolve({ proc, msg }));
    });

  it("excludes other processes and other connections of the same process", async () => {
    const a = await child("shard-0");
    expect(a.msg.type).toBe("held");
    expect((await child("shard-0", "try")).msg.type).toBe("busy"); // another process
    expect(await new SqliteFileLease(join(dir, "locks")).tryAcquire("shard-0")).toBeUndefined(); // this process
    expect((await child("shard-1", "try")).msg.type).toBe("held"); // other names are independent
    a.proc.kill("SIGKILL");
  });

  it("is released by the OS when the holder is killed (kill -9): no stale lock, epoch increases", async () => {
    const a = await child("shard-2");
    const lease = new SqliteFileLease(join(dir, "locks"));
    expect(await lease.tryAcquire("shard-2")).toBeUndefined();
    const died = new Promise((r) => a.proc.once("exit", r));
    a.proc.kill("SIGKILL");
    await died;
    const t0 = Date.now();
    const h = await lease.tryAcquire("shard-2");
    expect(h).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(h!.epoch).toBe(a.msg.epoch + 1);
    await h!.release();
    expect((await lease.tryAcquire("shard-2"))!.epoch).toBe(a.msg.epoch + 2);
  });
});

describe("P05c cross-host lease: CAS on a conditional store (S3 If-Match / If-None-Match)", () => {
  const opts = { ttlMs: 10_000, renewEveryMs: 3_000, skewMarginMs: 1_000 };

  it("one holder at a time; renewals keep it", async () => {
    const clock = new FakeClock();
    const store = new MemoryConditionalStore();
    const a = await new CasLease({ store, owner: "A", clock, ...opts }).tryAcquire("s0");
    const B = new CasLease({ store, owner: "B", clock, ...opts });
    expect(a?.epoch).toBe(1);
    expect(await B.tryAcquire("s0")).toBeUndefined();
    await clock.advance(60_000); // 20 renewal periods
    expect(a!.lost.aborted).toBe(false);
    expect(await B.tryAcquire("s0")).toBeUndefined();
  });

  it("a partitioned holder stops serving BEFORE anyone can take over (bounded skew)", async () => {
    const clock = new FakeClock();
    const store = new MemoryConditionalStore();
    let partitioned = false;
    const aStore: ConditionalStore = {
      get: (k) => store.get(k),
      put: (k, b, c) => (partitioned ? Promise.reject(new Error("network")) : store.put(k, b, c)),
    };
    const a = (await new CasLease({ store: aStore, owner: "A", clock, ...opts }).tryAcquire("s0"))!;
    const B = new CasLease({ store, owner: "B", clock, ...opts });
    await clock.advance(3_000); // renewed at t=3000 → expiresAt 13000
    partitioned = true;
    let lostAt = -1;
    a.lost.addEventListener("abort", () => (lostAt = clock.now()));
    let b = await B.tryAcquire("s0");
    while (!b) {
      await clock.advance(250);
      b = await B.tryAcquire("s0");
    }
    expect(lostAt).toBe(3_000 + opts.ttlMs - opts.skewMarginMs); // 12000: holder's local deadline
    expect(clock.now()).toBeGreaterThan(13_000 + opts.skewMarginMs); // taker waited expiresAt + skew
    expect(b.epoch).toBe(2);
  });

  it("a holder partitioned before its first renewal also stops at acquiredAt + ttl - skew", async () => {
    const clock = new FakeClock();
    const store = new MemoryConditionalStore();
    let partitioned = false;
    const aStore: ConditionalStore = {
      get: (k) => store.get(k),
      put: (k, b, c) => (partitioned ? Promise.reject(new Error("network")) : store.put(k, b, c)),
    };
    const a = (await new CasLease({ store: aStore, owner: "A", clock, ...opts }).tryAcquire("s0"))!;
    partitioned = true;
    let lostAt = -1;
    a.lost.addEventListener("abort", () => (lostAt = clock.now()));
    await clock.advance(20_000);
    expect(lostAt).toBe(opts.ttlMs - opts.skewMarginMs);
  });

  it("concurrent takers of an expired lease: exactly one wins", async () => {
    const clock = new FakeClock();
    const store = new MemoryConditionalStore();
    const a = (await new CasLease({ store, owner: "A", clock, ...opts }).tryAcquire("s0"))!;
    await a.release();
    const got = await Promise.all(
      ["B", "C", "D", "E"].map((o) =>
        new CasLease({ store, owner: o, clock, ...opts }).tryAcquire("s0"),
      ),
    );
    expect(got.filter(Boolean).length).toBe(1);
    expect(got.find(Boolean)!.epoch).toBe(2);
  });

  it("fencing: a paused ex-holder cannot write after its successor claimed the manifest", async () => {
    const clock = new FakeClock();
    const store = new MemoryConditionalStore();
    let paused = false;
    const aStore: ConditionalStore = {
      get: (k) => store.get(k),
      put: (k, b, c) => (paused ? new Promise(() => {}) : store.put(k, b, c)),
    };
    const a = (await new CasLease({ store: aStore, owner: "A", clock, ...opts }).tryAcquire("s0"))!;
    const ma = new FencedManifest<{ head: number }>(store, "manifests/s0", a.epoch);
    await ma.claim({ head: 0 });
    await ma.write({ head: 1 });
    // A is "paused" (GC, suspended VM): its renewals make no progress and it ignores `lost`.
    paused = true;
    await clock.advance(30_000);
    const b = (await new CasLease({ store, owner: "B", clock, ...opts }).tryAcquire("s0"))!;
    const mb = new FencedManifest<{ head: number }>(store, "manifests/s0", b.epoch);
    expect(await mb.claim({ head: 0 })).toEqual({ head: 1 }); // successor sees A's last durable state
    await expect(ma.write({ head: 99 })).rejects.toBeInstanceOf(FencedError); // A wakes up: fenced
    await expect(
      new FencedManifest(store, "manifests/s0", a.epoch).claim({ head: 0 }),
    ).rejects.toThrow(/epoch 2/);
    await mb.write({ head: 2 });
    expect(JSON.parse((await store.get("manifests/s0"))!.body)).toEqual({
      epoch: 2,
      state: { head: 2 },
    });
  });

  it("the same CAS contract holds on a shared SQLite file (two connections = two processes)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cells-cas-")), "cas.sqlite");
    const s1 = new SqliteConditionalStore(file);
    const s2 = new SqliteConditionalStore(file);
    const clock = new FakeClock();
    const a = await new CasLease({ store: s1, owner: "A", clock, ...opts }).tryAcquire("s0");
    expect(a).toBeDefined();
    expect(
      await new CasLease({ store: s2, owner: "B", clock, ...opts }).tryAcquire("s0"),
    ).toBeUndefined();
    const { etag } = (await s2.get("leases/s0"))!;
    const results = await Promise.allSettled([
      s1.put("leases/s0", "x", { ifMatch: etag }),
      s2.put("leases/s0", "y", { ifMatch: etag }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    s1.close();
    s2.close();
  });
});
