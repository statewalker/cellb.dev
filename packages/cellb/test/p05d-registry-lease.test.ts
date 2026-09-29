import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RegistryLease } from "../src/adapters/registry-lease.js";
import type { Clock } from "../src/index.js";
import { FakeClock } from "./fake-clock.js";

/** Per-process view of a shared fake clock that can be paused (GC pause) or crashed. */
class ProcessClock implements Clock {
  paused = false;
  #queued: (() => void)[] = [];
  constructor(private readonly master: FakeClock) {}
  now() {
    return this.master.now();
  }
  setTimeout(fn: () => void, ms: number) {
    return this.master.setTimeout(() => (this.paused ? this.#queued.push(fn) : fn()), ms);
  }
  clearTimeout(h: unknown) {
    this.master.clearTimeout(h);
  }
  resume() {
    this.paused = false;
    for (const f of this.#queued.splice(0)) f();
  }
}

// Server ownership "as in Miniflare 4": heartbeat files, oldest live candidate owns.
describe("P05d registry lease (Miniflare-4 style), in-process with a fake clock", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-reg-"));
    const clock = new FakeClock();
    const mk = (id: string) => {
      const pc = new ProcessClock(clock);
      return {
        lease: new RegistryLease({
          dir,
          candidateId: id,
          heartbeatMs: 2_000,
          staleMs: 10_000,
          clock: pc,
        }),
        pc,
      };
    };
    return { dir, clock, mk };
  };

  it("the oldest live candidate owns; a younger one waits while heartbeats continue", async () => {
    const { clock, mk } = setup();
    const a = mk("A");
    const b = mk("B");
    const ha = await a.lease.tryAcquire("shard-0");
    await clock.advance(1);
    expect(ha).toBeDefined();
    expect(await b.lease.tryAcquire("shard-0")).toBeUndefined();
    await clock.advance(30_000);
    expect(ha!.lost.aborted).toBe(false);
    expect(await b.lease.tryAcquire("shard-0")).toBeUndefined();
    expect(a.lease.candidates("shard-0").map((c) => c.candidateId)).toEqual(["A", "B"]);
  });

  it("a crashed owner is replaced only after its entry went stale; the stale entry is removed", async () => {
    const { dir, clock, mk } = setup();
    const a = mk("A");
    const b = mk("B");
    await a.lease.tryAcquire("s");
    await clock.advance(1);
    await b.lease.tryAcquire("s");
    a.pc.paused = true; // crash: no more heartbeats, never resumed
    await clock.advance(9_000);
    expect(await b.lease.tryAcquire("s")).toBeUndefined(); // A's entry still fresh enough
    await clock.advance(2_000);
    const hb = await b.lease.tryAcquire("s");
    expect(hb).toBeDefined();
    expect(existsSync(join(dir, "s", "A.json"))).toBe(false); // cleaned up by B
  });

  it("graceful release hands over at once (stop serving, then withdraw)", async () => {
    const { clock, mk } = setup();
    const a = mk("A");
    const b = mk("B");
    const ha = await a.lease.tryAcquire("s");
    await clock.advance(1);
    expect(await b.lease.tryAcquire("s")).toBeUndefined();
    await ha!.release();
    expect(ha!.lost.aborted).toBe(true);
    expect(await b.lease.tryAcquire("s")).toBeDefined();
  });

  it("a PAUSED owner whose entry was removed steps down when it resumes (comes back as the youngest)", async () => {
    const { clock, mk } = setup();
    const a = mk("A");
    const b = mk("B");
    const ha = await a.lease.tryAcquire("s");
    await clock.advance(1);
    await b.lease.tryAcquire("s");
    a.pc.paused = true; // long GC pause / SIGSTOP
    await clock.advance(12_000);
    const hb = await b.lease.tryAcquire("s");
    expect(hb).toBeDefined();
    a.pc.resume();
    await clock.advance(2_000);
    expect(ha!.lost.aborted).toBe(true);
    expect(hb!.lost.aborted).toBe(false);
    expect(await a.lease.tryAcquire("s")).toBeUndefined(); // A re-registered, now younger than B
  });

  it("no fencing (documented Miniflare limitation): during the pause both believe they own", async () => {
    const { clock, mk } = setup();
    const a = mk("A");
    const b = mk("B");
    const ha = await a.lease.tryAcquire("s");
    await clock.advance(1);
    await b.lease.tryAcquire("s");
    a.pc.paused = true;
    await clock.advance(12_000);
    const hb = await b.lease.tryAcquire("s");
    // A has not run any code yet: its handle still says "not lost". Only storage-level
    // fencing (exclusive SQLite files on one host, epoch-fenced manifest across hosts) helps.
    expect(ha!.lost.aborted).toBe(false);
    expect(hb).toBeDefined();
  });
});

describe("P05d registry lease across real processes (kill -9)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cells-regp-"));
  let bundle = "";
  const procs: ChildProcess[] = [];
  beforeAll(async () => {
    bundle = join(dir, "registry-holder.mjs");
    await build({
      entryPoints: [join(__dirname, "registry-holder.entry.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
  });
  afterAll(() => {
    for (const p of procs) p.kill("SIGKILL");
  });
  const spawn = (id: string, shard = "shard-0") => {
    const p = fork(bundle, [join(dir, "reg"), shard, id], { execArgv: ["--no-warnings"] });
    procs.push(p);
    const next = (type: string) =>
      new Promise<any>((r) => {
        const h = (m: any) => m.type === type && (p.off("message", h), r(m));
        p.on("message", h);
      });
    return { p, next };
  };

  it("oldest process owns; after kill -9 the next one takes over within staleMs + a heartbeat", async () => {
    const a = spawn("A");
    await a.next("owner");
    const b = spawn("B");
    await b.next("registered");
    const early = await Promise.race([
      b.next("owner").then(() => "owner"),
      new Promise((r) => setTimeout(() => r("waiting"), 500)),
    ]);
    expect(early).toBe("waiting");
    const t0 = Date.now();
    a.p.kill("SIGKILL");
    await b.next("owner");
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250); // not before A's entry is stale (300 ms)
    expect(took).toBeLessThan(1_500);
  });

  it("graceful release hands over without waiting for staleness", async () => {
    const e = spawn("E", "shard-1");
    await e.next("owner");
    const f = spawn("F", "shard-1");
    await f.next("registered");
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    e.p.send("release");
    await e.next("released");
    await f.next("owner");
    expect(Date.now() - t0).toBeLessThan(250); // < staleMs (300): no TTL wait
  });
});
