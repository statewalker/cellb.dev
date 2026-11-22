import { describe, expect, it } from "vitest";
import type { LogRecord } from "../src/bucket/celld-cells.js";
import { celldBucket, memoryObjectStore } from "../src/index.js";

// The node record as a leader in celld's log tier keeps it (celld 0.6.3 node_log.rs,
// ownership_store.rs): the `log` object lives in nodes/<node>.json and is written only through
// the node's own lease chain, by compare-and-swap, so a recoverer's write to a dead-looking
// node's record is never overwritten by a late renewal; a node whose renewal is refused that way
// fences itself (statewalker/cellb.dev#209).
const dec = new TextDecoder();
const enc = new TextEncoder();
const cellKey = `Counter/${"6".repeat(64)}`;
const read = async (store: ReturnType<typeof memoryObjectStore>, node: string) => {
  const o = await store.get(`nodes/${node}.json`);
  return o ? JSON.parse(dec.decode(o.body)) : undefined;
};
const openLog = (epoch: number, ensemble: string[]): LogRecord => ({
  state: "open",
  epoch,
  ensemble,
  tiered: 0,
  active: false,
  claimant: null,
  claimed_ms: null,
});

describe("P52 the node record carries the log, by compare-and-swap", () => {
  it("a renewal refused because another node rewrote the record fences the cells, and keeps that record", async () => {
    const store = memoryObjectStore();
    const ttl = 900;
    const b = celldBucket(store, { node: "n", leaseTtlMs: ttl });
    try {
      const lease = await b.ownership.tryAcquire(cellKey);
      await b.setLog(openLog(1, ["f"]));
      // a recoverer claims what it took for a dead leader's log
      const rec = await read(store, "n");
      const claimed = {
        ...rec,
        log: { ...rec.log, state: "recovering", claimant: "r", claimed_ms: Date.now() },
      };
      await store.put("nodes/n.json", enc.encode(JSON.stringify(claimed)));
      const fenced = await new Promise<boolean>((res) => {
        lease!.lost.addEventListener("abort", () => res(true));
        setTimeout(() => res(false), 3 * ttl);
      });
      expect(fenced).toBe(true);
      const after = await read(store, "n");
      expect(after.log).toMatchObject({ state: "recovering", claimant: "r" });
    } finally {
      await b.close();
    }
  });

  it("setLog publishes the log object and renewals keep it", async () => {
    const store = memoryObjectStore();
    const b = celldBucket(store, { node: "n2", leaseTtlMs: 600 });
    try {
      await b.ownership.tryAcquire(cellKey);
      await b.setLog(openLog(4, ["x", "y"]));
      expect((await read(store, "n2")).log).toEqual(openLog(4, ["x", "y"]));
      const first = (await read(store, "n2")).expires_ms;
      await new Promise((r) => setTimeout(r, 450)); // a renewal or two
      const later = await read(store, "n2");
      expect(later.expires_ms).toBeGreaterThan(first);
      expect(later.log).toEqual(openLog(4, ["x", "y"]));
    } finally {
      await b.close();
    }
  });

  it("closing a node that published a log keeps its record, expired, instead of deleting it", async () => {
    const store = memoryObjectStore();
    const b = celldBucket(store, { node: "n3", leaseTtlMs: 600 });
    await b.ownership.tryAcquire(cellKey);
    await b.setLog({ ...openLog(2, ["f"]), state: "sealed" as const });
    await b.close();
    const rec = await read(store, "n3");
    expect(rec?.log).toMatchObject({ state: "sealed", epoch: 2 });
    expect(rec.expires_ms).toBeLessThanOrEqual(Date.now());
    // a node without a log still leaves no record
    const c = celldBucket(store, { node: "n4", leaseTtlMs: 600 });
    await c.ownership.tryAcquire(`Counter/${"7".repeat(64)}`);
    await c.close();
    expect(await read(store, "n4")).toBeUndefined();
  });

  it("a node started under the name of a live record waits for it to expire", async () => {
    const store = memoryObjectStore();
    const expires = Date.now() + 700;
    await store.put(
      "nodes/n5.json",
      enc.encode(
        JSON.stringify({
          node: "n5",
          expires_ms: expires,
          addr: "127.0.0.1:1",
          ownership_index_generation: "old",
        }),
      ),
    );
    const b = celldBucket(store, { node: "n5", leaseTtlMs: 600 });
    try {
      await b.ownership.tryAcquire(cellKey);
      expect(Date.now()).toBeGreaterThanOrEqual(expires);
      expect((await read(store, "n5")).ownership_index_generation).not.toBe("old");
    } finally {
      await b.close();
    }
  });
});

// Merge gate #213, pass 1 (high): waiting for a dead predecessor's session to be recovered, a
// starting node retried at once when recovery could not finish (left to celld, claimed elsewhere):
// a tight loop against the bucket.
describe("P52 waiting for a predecessor's session", () => {
  it("retries at a measured pace when its recovery cannot finish yet", async () => {
    const store = memoryObjectStore();
    await store.put(
      "nodes/p.json",
      enc.encode(
        JSON.stringify({
          node: "p",
          expires_ms: Date.now() - 60_000,
          addr: "127.0.0.1:1",
          ownership_index_generation: "old",
          log: openLog(1, ["f"]),
        }),
      ),
    );
    let attempts = 0;
    const b = celldBucket(store, {
      node: "p",
      leaseTtlMs: 600,
      recoverPredecessor: async () => {
        attempts++; // recovery cannot finish (celld's bundles, another claim)
      },
    });
    const acquiring = b.ownership.tryAcquire(`Counter/${"8".repeat(64)}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(10);
    // recovered by someone: the node starts
    const rec = await read(store, "p");
    await store.put(
      "nodes/p.json",
      enc.encode(JSON.stringify({ ...rec, log: { ...rec.log, state: "sealed" } })),
    );
    await acquiring;
    await b.close();
  });
});
