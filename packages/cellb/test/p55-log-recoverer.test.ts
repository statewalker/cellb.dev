import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  celldBucket,
  createCellRuntime,
  memoryObjectStore,
  type ObjectStore,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import { startCelldPeerServer } from "../src/peer/celld-peer.js";
import { createLogFollower } from "../src/peer/log-follower.js";
import { createLogLeader } from "../src/peer/log-leader.js";
import { createLogRecoverer } from "../src/peer/log-recoverer.js";

// Recovering a dead leader's log tier session (celld 0.6.3 node_log.rs recover, logic/log_tier.rs;
// statewalker/cellb.dev#209): claim the record, seal the followers, gather their tails, upload
// what the bucket lacks in TXID order, seal the record. Then the cells can be taken: the takeover
// gate waits for `sealed`.
const cellKey = `Counter/${"a".repeat(64)}`;
const scope = `Counter:${"a".repeat(64)}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const image = (n: number) => {
  const b = new Uint8Array(4096);
  b.set(enc.encode("SQLite format 3\0"));
  b[16] = 0x10;
  b[100] = n;
  return b;
};
const record = async (store: ObjectStore, node: string) => {
  const o = await store.get(`nodes/${node}.json`);
  return o ? JSON.parse(dec.decode(o.body)) : undefined;
};

async function followerNode(store: ObjectStore, node: string) {
  const bucket = celldBucket(store, { node, leaseTtlMs: 5_000 });
  const runtime = createCellRuntime({ worker: { default: {} }, openSql: nodeSqliteOpener() });
  const follower = createLogFollower({
    dir: mkdtempSync(join(tmpdir(), `r-${node}-`)),
    store,
    node,
  });
  const peer = await startCelldPeerServer({ runtime, store, node, follower });
  await (await bucket.ownership.tryAcquire(`C/warm-${node}`))?.release();
  await bucket.advertise(peer.addr);
  return {
    node,
    peer,
    close: async () => {
      await peer.close();
      await runtime.close();
      await bucket.close();
    },
  };
}

/**
 * A leader that dies: its cell files never reach the bucket (held), its renewals stop, so its
 * record expires with the session open and active; its acknowledged commits live only on its
 * followers.
 */
async function deadLeader(store: ObjectStore, commits: number) {
  let dead = false;
  const wrapped: ObjectStore = {
    get: (k) => mem(k),
    list: (p) => store.list(p),
    delete: (k) => (dead ? new Promise(() => {}) : store.delete(k)),
    put: (k, b, c, a) =>
      dead || k.includes("/ltx/") ? new Promise<string>(() => {}) : store.put(k, b, c, a),
  };
  const mem = (k: string) => store.get(k);
  const bucket = celldBucket(wrapped, { node: "lead", leaseTtlMs: 600 });
  const leader = createLogLeader({ bucket, store, node: "lead" });
  bucket.setShipper(leader.shipper);
  const lease = (await bucket.ownership.tryAcquire(cellKey))!;
  await leader.maintain();
  for (let n = 1; n <= commits; n++)
    await bucket.durability.committed(cellKey, { seq: n, image: image(n), epoch: lease.epoch });
  dead = true; // the process is gone: nothing more reaches the bucket
  const rec = await record(store, "lead");
  while ((await record(store, "lead")).expires_ms > Date.now())
    await new Promise((r) => setTimeout(r, 50));
  return { rec, epoch: lease.epoch };
}

describe("P55 recovering a dead leader's session", () => {
  it("uploads the acknowledged commits only its followers hold, in TXID order, and seals the record", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "f1");
    const f2 = await followerNode(store, "f2");
    try {
      const { rec, epoch } = await deadLeader(store, 3);
      expect(rec.log).toMatchObject({ state: "open", active: true, ensemble: ["f1", "f2"] });
      expect(await store.list(`cells/${scope}/ltx/`)).toEqual([]); // nothing in the bucket
      const r = createLogRecoverer({ store, node: "f1" });
      expect(await r.recover("lead")).toBe("sealed");
      expect(await store.list(`cells/${scope}/ltx/`)).toEqual([
        `cells/${scope}/ltx/e${epoch}/0000/0000000000000001-0000000000000001.ltx`,
        `cells/${scope}/ltx/e${epoch}/0000/0000000000000002-0000000000000002.ltx`,
        `cells/${scope}/ltx/e${epoch}/0000/0000000000000003-0000000000000003.ltx`,
      ]);
      expect((await record(store, "lead")).log).toMatchObject({
        state: "sealed",
        claimant: null,
        claimed_ms: null,
      });
      // the cell restores with all three commits
      const next = celldBucket(store, { node: "next", leaseTtlMs: 5_000 });
      const restored = await next.durability.load?.(cellKey);
      expect(restored?.[100]).toBe(3);
      await next.close();
    } finally {
      await f1.close();
      await f2.close();
    }
  });

  it("a live leader is not recovered", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "g1");
    const bucket = celldBucket(store, { node: "alive", leaseTtlMs: 5_000 });
    const leader = createLogLeader({ bucket, store, node: "alive" });
    bucket.setShipper(leader.shipper);
    try {
      await bucket.ownership.tryAcquire(cellKey);
      await leader.maintain();
      expect(await createLogRecoverer({ store, node: "g1" }).recover("alive")).toBe("live");
      expect((await record(store, "alive")).log.state).toBe("open");
    } finally {
      await leader.close();
      await bucket.close();
      await f1.close();
    }
  });

  it("an active session with no follower to witness it, and one that may come back, is not sealed", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "h1");
    try {
      await deadLeader(store, 2);
      await f1.peer.close(); // h1's record is still live: it may come back
      const r = createLogRecoverer({ store, node: "other" });
      await expect(r.recover("lead")).rejects.toThrow(/witness/);
      expect((await record(store, "lead")).log.state).not.toBe("sealed");
    } finally {
      await f1.close();
    }
  });

  it("a sweep recovers every expired session that is not sealed", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "s1");
    try {
      await deadLeader(store, 1);
      const r = createLogRecoverer({ store, node: "s1" });
      await r.sweep();
      expect((await record(store, "lead")).log.state).toBe("sealed");
      expect((await store.list(`cells/${scope}/ltx/`)).length).toBe(1);
    } finally {
      await f1.close();
    }
  });
});
