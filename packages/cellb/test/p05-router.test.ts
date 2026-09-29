import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CellRouter,
  idFromNameForTest,
  linkOverPort,
  remoteRuntime,
  serveHandlerOverPort,
  shardOf,
} from "./router-helpers.js";

const SHARDS = 3;
const BINDINGS = { COUNTER: "Counter" };

describe("P05a one router, several shard workers over MessagePorts", () => {
  let bundle = "";
  const dir = mkdtempSync(join(tmpdir(), "cells-shards-"));
  const threads: Worker[] = [];
  beforeAll(async () => {
    bundle = join(dir, "shard-worker.mjs");
    await build({
      entryPoints: [join(__dirname, "shard-worker.entry.ts")],
      outfile: bundle,
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
  afterAll(async () => {
    for (const w of threads) await w.terminate();
  });

  /** What a page does for the ServiceWorker: spawn a shard worker, wire 2 channels, attach to the router. */
  async function startShard(router: CellRouter, shard: number, token?: unknown) {
    const w = new Worker(bundle, { workerData: { shard, shards: SHARDS, dir } });
    threads.push(w);
    if (token !== undefined) exits.set(token, new Promise((r) => w.once("exit", r)));
    await new Promise((r) => w.once("message", r)); // booted
    const down = new MessageChannel(); // router → shard
    const up = new MessageChannel(); // shard → router
    await serveHandlerOverPort(up.port1 as any, router.internal);
    w.postMessage({ type: "link", down: down.port2, up: up.port2 }, [
      down.port2 as any,
      up.port2 as any,
    ]);
    await new Promise((r) => w.once("message", r)); // linked
    const link = await linkOverPort(down.port1 as any);
    router.attach(shard, link.send, token);
    return { w, link };
  }

  const exits = new Map<unknown, Promise<unknown>>(); // Node's event-driven liveness: worker "exit"
  let seq = 0; // the shard files persist in `dir`: every call gets fresh names
  const names = (want: number, count: number) => {
    const out: string[] = [];
    const p = `t${seq++}-`;
    for (let i = 0; out.length < count; i++)
      if (shardOf(idFromNameForTest("Counter", `${p}${i}`), SHARDS) === want) out.push(`${p}${i}`);
    return out;
  };

  it("routes every object to its shard, and DO → DO calls cross shards through the router", async () => {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS });
    for (let s = 0; s < SHARDS; s++) await startShard(router, s);
    const client = await remoteRuntime(router.internal);
    for (let s = 0; s < SHARDS; s++)
      for (const n of names(s, 2)) expect(await client.env.COUNTER.getByName(n).shard()).toBe(s);

    const [a] = names(0, 1);
    const [b] = names(2, 1);
    expect(await client.env.COUNTER.getByName(a).bump(b, 5)).toEqual({ me: 0, other: 2, n: 5 });
  });

  it("public ingress reaches the Worker fetch in some shard, and control headers from clients are ignored", async () => {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS });
    for (let s = 0; s < SHARDS; s++) await startShard(router, s);
    const r = await router.ingress(
      new Request(`http://x/counter/ing${Date.now()}/inc`, {
        method: "POST",
        headers: { "x-webrun-cells": "rpc", "x-webrun-cells-method": "increment" },
      }),
    );
    expect(await r.json()).toEqual({ n: 1 }); // went through the Worker's routing, not a forged RPC
  });

  it("the input gate holds for concurrent calls arriving from several shards", async () => {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS });
    for (let s = 0; s < SHARDS; s++) await startShard(router, s);
    const client = await remoteRuntime(router.internal);
    const [target] = names(1, 1);
    const callers = [...names(0, 5), ...names(2, 5)];
    const res = await Promise.all(
      callers.map((c) => client.env.COUNTER.getByName(c).bump(target, 1)),
    );
    expect(new Set(res.map((r) => r.n)).size).toBe(10);
  });

  it("requests for a missing shard wait until it is (re)attached; state survives the shard restart", async () => {
    const asked: number[] = [];
    const router = new CellRouter({
      shards: SHARDS,
      bindings: BINDINGS,
      onMissingShard: (s) => asked.push(s),
    });
    for (let s = 0; s < SHARDS; s++) if (s !== 1) await startShard(router, s);
    const first = await startShard(router, 1);
    const client = await remoteRuntime(router.internal);
    const [x] = names(1, 1);
    expect(await client.env.COUNTER.getByName(x).increment(3)).toBe(3);

    router.detach(1);
    await first.w.terminate(); // tab closed / worker crashed
    const pending = client.env.COUNTER.getByName(x).increment(1); // waits for shard 1
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toContain(1);
    await startShard(router, 1); // another tab took the lock and attached
    expect(await pending).toBe(4);
  });

  it("gives up with an error when a shard never comes back", async () => {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS, attachTimeoutMs: 50 });
    const client = await remoteRuntime(router.internal);
    await expect(client.env.COUNTER.getByName("nobody").value()).rejects.toThrow(/not attached/);
  });

  it("a new owner attaching fails the old owner's in-flight requests at once (no hang on a dead port)", async () => {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS });
    for (let s = 0; s < SHARDS; s++) if (s !== 1) await startShard(router, s);
    const old = await startShard(router, 1);
    const client = await remoteRuntime(router.internal);
    const [x] = names(1, 1);
    const t0 = Date.now();
    const inflight = client.env.COUNTER.getByName(x).slow(10_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(router.inflight(1)).toBe(1);
    await old.w.terminate(); // owner tab died mid-request; its port is silently dead
    await startShard(router, 1); // next lock holder attaches
    await expect(inflight).rejects.toThrow(/Owner of cell shard 1 was lost/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(await client.env.COUNTER.getByName(x).increment(1)).toBe(1); // new owner serves
  });

  it("the liveness watchdog fails in-flight requests when the owner is gone and nobody takes over", async () => {
    let alive = true;
    const router = new CellRouter({
      shards: SHARDS,
      bindings: BINDINGS,
      isAlive: async (_s, tok) => tok !== "owner-A" || alive,
      livenessIntervalMs: 50,
    });
    for (let s = 0; s < SHARDS; s++) if (s !== 2) await startShard(router, s);
    const a = await startShard(router, 2, "owner-A");
    const [x] = names(2, 1);
    const t0 = Date.now();
    const res = router.ingress(new Request(`http://x/counter/${x}/slow/10000`));
    await new Promise((r) => setTimeout(r, 100));
    await a.w.terminate();
    alive = false; // e.g. the Web Lock of shard 2 is no longer held by that holder
    const r = await res;
    // The Worker's fetch ran in another shard; its stub call into shard 2 threw
    // ShardOwnerLostError, which the Worker surfaces as a 500 (as on Cloudflare).
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/Owner of cell shard 2 was lost/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(router.attachedShards).not.toContain(2);
  });

  it("event-driven owner watch (Node: worker exit) fails in-flight requests without polling", async () => {
    const router = new CellRouter({
      shards: SHARDS,
      bindings: BINDINGS,
      watchOwner: (_s, tok) => exits.get(tok)!,
    });
    for (let s = 0; s < SHARDS; s++) if (s !== 0) await startShard(router, s);
    const a = await startShard(router, 0, "owner-0");
    const [x] = names(0, 1);
    const client = await remoteRuntime(router.internal);
    const inflight = client.env.COUNTER.getByName(x).slow(10_000);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await a.w.terminate();
    await expect(inflight).rejects.toThrow(/Owner of cell shard 0 was lost/);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(router.attachedShards).not.toContain(0);
  });
});
