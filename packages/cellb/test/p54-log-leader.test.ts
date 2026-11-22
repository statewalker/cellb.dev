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
import { createLogFollower, decodeTail } from "../src/peer/log-follower.js";
import { createLogLeader } from "../src/peer/log-leader.js";

// cellb as a LEADER in celld's log tier (celld 0.6.3 node_log.rs, logic/log_tier.rs;
// statewalker/cellb.dev#209): it recruits followers, ships each commit's L0 segment to them, and
// acknowledges a commit once every follower holds it (or the bucket does), with `active`
// published first; any failure degrades the epoch to the bucket; a new epoch opens only once
// nothing shipped is missing from the bucket.
const cellKey = `Counter/${"9".repeat(64)}`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const image = (n: number) => {
  const b = new Uint8Array(4096);
  b.set(enc.encode("SQLite format 3\0"));
  b[16] = 0x10;
  b[100] = n;
  return b;
};

/** A follower node: its own lease, a peer server serving the follower side (or none). */
async function followerNode(store: ObjectStore, node: string, serve = true) {
  const bucket = celldBucket(store, { node, leaseTtlMs: 5_000 });
  const runtime = createCellRuntime({ worker: { default: {} }, openSql: nodeSqliteOpener() });
  const follower = createLogFollower({
    dir: mkdtempSync(join(tmpdir(), `f-${node}-`)),
    store,
    node,
  });
  const peer = await startCelldPeerServer({
    runtime,
    store,
    node,
    follower: serve ? follower : undefined,
  });
  await (await bucket.ownership.tryAcquire(`C/warm-${node}`))?.release(); // a live record
  await bucket.advertise(peer.addr);
  return {
    node,
    follower,
    peer,
    close: async () => {
      await peer.close();
      await runtime.close();
      await bucket.close();
    },
  };
}

/** A bucket whose cell-file PUTs can be held. */
function holdable(mem: ObjectStore) {
  let hold = false;
  const held: (() => void)[] = [];
  const store: ObjectStore = {
    get: (k) => mem.get(k),
    list: (p) => mem.list(p),
    delete: (k) => mem.delete(k),
    put: async (k, b, c, a) => {
      if (hold && k.includes("/ltx/")) await new Promise<void>((r) => held.push(r));
      return mem.put(k, b, c, a);
    },
  };
  return {
    store,
    hold: (on: boolean) => {
      hold = on;
      if (!on) for (const r of held.splice(0)) r();
    },
    held,
  };
}

async function leaderNode(
  store: ObjectStore,
  opts: { maxFollowers?: number; fetch?: typeof fetch } = {},
) {
  const h = holdable(store);
  const bucket = celldBucket(h.store, { node: "lead", leaseTtlMs: 5_000 });
  const leader = createLogLeader({ bucket, store, node: "lead", ...opts });
  bucket.setShipper(leader.shipper);
  const lease = (await bucket.ownership.tryAcquire(cellKey))!;
  let seq = 0;
  const commit = () =>
    bucket.durability.committed(cellKey, { seq: ++seq, image: image(seq), epoch: lease.epoch });
  return { bucket, leader, lease, commit, ...h };
}
const record = async (store: ObjectStore, node: string) =>
  JSON.parse(dec.decode((await store.get(`nodes/${node}.json`))!.body));
const tailOf = async (f: Awaited<ReturnType<typeof followerNode>>, session: string) =>
  decodeTail(await f.follower.tail({ leader: session, tail_format: 2 }));

describe("P54 cellb leads a log tier session", () => {
  it("recruits followers, ships each commit to them, and publishes `active` before acknowledging on them", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "f1");
    const f2 = await followerNode(store, "f2");
    const l = await leaderNode(store);
    try {
      await l.leader.maintain();
      expect((await record(store, "lead")).log).toMatchObject({
        state: "open",
        epoch: 1,
        ensemble: ["f1", "f2"],
        active: false,
      });
      l.hold(true); // the bucket is slow: only the followers can acknowledge
      await l.commit();
      await l.commit();
      expect(l.held.length).toBeGreaterThan(0); // acknowledged, though not in the bucket yet
      expect((await record(store, "lead")).log.active).toBe(true);
      const session = await l.bucket.session();
      for (const f of [f1, f2])
        expect((await tailOf(f, session)).entries.map((e) => [e.seq, e.txid])).toEqual([
          [1, 1],
          [2, 2],
        ]);
      l.hold(false);
    } finally {
      l.hold(false);
      await l.leader.close();
      await l.bucket.close();
      await f1.close();
      await f2.close();
    }
  });

  it("truncate_to follows the bucket: followers drop what it holds", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "g1");
    const l = await leaderNode(store);
    try {
      await l.leader.maintain();
      for (let i = 0; i < 3; i++) await l.commit();
      await l.leader.settled(); // the followers hold all three
      await l.bucket.flush(cellKey); // and so does the bucket
      await l.commit(); // carries truncate_to = 3
      await l.leader.settled();
      const t = await tailOf(f1, await l.bucket.session());
      expect(t.base).toBe(3);
      expect(t.entries.map((e) => e.seq)).toEqual([4]);
    } finally {
      await l.leader.close();
      await l.bucket.close();
      await f1.close();
    }
  });

  it("a follower that fails degrades the epoch to the bucket; the next opens without it once the bucket has everything", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "h1");
    const f2 = await followerNode(store, "h2");
    const l = await leaderNode(store);
    try {
      await l.leader.maintain();
      await l.commit();
      await l.leader.settled();
      await f2.close(); // gone (its record lingers until it expires)
      l.hold(true);
      const pending = l.commit();
      const raced = await Promise.race([
        pending.then(() => "acked"),
        new Promise((r) => setTimeout(() => r("waiting"), 300)),
      ]);
      expect(raced).toBe("waiting"); // no fleet proof: it waits for the bucket
      l.hold(false);
      await pending;
      await store.delete("nodes/h2.json"); // its record is gone too
      await l.leader.maintain();
      expect((await record(store, "lead")).log).toMatchObject({
        state: "open",
        epoch: 2,
        ensemble: ["h1"],
      });
    } finally {
      l.hold(false);
      await l.leader.close();
      await l.bucket.close();
      await f1.close();
    }
  });

  it("a node that cannot follow (404) is quarantined, not recruited", async () => {
    const store = memoryObjectStore();
    const ok = await followerNode(store, "k1");
    const no = await followerNode(store, "k2", false);
    const l = await leaderNode(store);
    try {
      await l.leader.maintain(); // recruits both
      await l.commit(); // k2 answers 404: quarantined, the epoch degrades
      await l.leader.settled();
      await l.bucket.flush(cellKey);
      await l.leader.maintain();
      expect((await record(store, "lead")).log).toMatchObject({ epoch: 2, ensemble: ["k1"] });
    } finally {
      await l.leader.close();
      await l.bucket.close();
      await ok.close();
      await no.close();
    }
  });

  it("close() seals the session once the bucket holds everything", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "s1");
    const l = await leaderNode(store);
    try {
      await l.leader.maintain();
      await l.commit();
      await l.leader.close();
      expect((await record(store, "lead")).log).toMatchObject({
        state: "sealed",
        epoch: 1,
        active: true,
      });
    } finally {
      await l.bucket.close();
      await f1.close();
    }
  });

  it("with no peer to follow, it leads nothing and the bucket acknowledges", async () => {
    const store = memoryObjectStore();
    const l = await leaderNode(store);
    try {
      await l.leader.maintain();
      await l.commit();
      expect((await record(store, "lead")).log).toBeUndefined();
    } finally {
      await l.leader.close();
      await l.bucket.close();
    }
  });

  // A follower gone with several rounds in flight: every round after the failed one fails too,
  // and none may be left rejected with no one listening (it killed the node: an unhandled
  // rejection; seen in p11k's graceful leave).
  it("rounds in flight when a follower goes all fail quietly; the commits fall back to the bucket", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "m1");
    const f2 = await followerNode(store, "m2");
    const l = await leaderNode(store);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await l.leader.maintain();
      await l.commit();
      await l.leader.settled();
      await f2.peer.close(); // m2 stops answering
      await Promise.all([l.commit(), l.commit(), l.commit(), l.commit()]);
      await l.leader.settled();
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await l.leader.close();
      await l.bucket.close();
      await f1.close();
      await f2.close();
    }
  });

  // celld ships a round as one append holding every captured row; one append per commit on a
  // follower's ordered lane serialized a node's whole commit stream behind one round trip and
  // one follower fsync at a time (#210's measurements: p50 56 ms with two cellb nodes).
  it("commits made while an append is in flight go together in the next append", async () => {
    const store = memoryObjectStore();
    const f1 = await followerNode(store, "b1");
    let appends = 0;
    const counting: typeof fetch = (input, init) => {
      if (String(input).endsWith("/peer/log/append")) appends++;
      return fetch(input, init);
    };
    const l = await leaderNode(store, { fetch: counting });
    try {
      await l.leader.maintain();
      l.hold(true); // only the follower acknowledges
      const cells = Array.from(
        { length: 20 },
        (_, i) => `Counter/${i.toString(16).padStart(64, "0")}`,
      );
      await Promise.all(
        cells.map(async (c) => {
          const lease = (await l.bucket.ownership.tryAcquire(c))!;
          await l.bucket.durability.committed(c, { seq: 1, image: image(1), epoch: lease.epoch });
        }),
      );
      await l.leader.settled();
      expect(appends).toBeLessThan(10); // 20 commits, a few appends
      const t = decodeTail(
        await f1.follower.tail({ leader: await l.bucket.session(), tail_format: 2 }),
      );
      expect(t.entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    } finally {
      l.hold(false);
      await l.leader.close();
      await l.bucket.close();
      await f1.close();
    }
  });
});
