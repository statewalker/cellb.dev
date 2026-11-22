import { describe, expect, it } from "vitest";
import type { SegmentShipper } from "../src/bucket/ltx-log.js";
import { celldBucket, memoryObjectStore, type ObjectStore } from "../src/index.js";

// A log tier leader acknowledges a commit once its followers hold the commit's LTX segment, or
// once the segment is in the bucket, whichever comes first (celld 0.6.3 docs/guarantees.md, "The
// acknowledgement rule"). The bucket still gets every segment, in TXID order per cell (celld's
// recovery skips rows at or below the highest TXID it lists), and a cell is released only once
// its segments are in the bucket: the next owner restores from there (statewalker/cellb.dev#209).
const cellKey = `Counter/${"8".repeat(64)}`;
const scope = `Counter:${"8".repeat(64)}`;

/** A bucket whose cell-file PUTs wait until released, one by one, or fail on demand. */
function slowStore() {
  const mem = memoryObjectStore();
  const held: (() => void)[] = [];
  let hold = false;
  let failNext = 0;
  const order: string[] = [];
  const store: ObjectStore = {
    get: (k) => mem.get(k),
    list: (p) => mem.list(p),
    delete: (k) => mem.delete(k),
    put: async (k, b, c, a) => {
      if (k.includes("/ltx/")) {
        if (failNext > 0) {
          failNext--;
          throw new Error("bucket unavailable");
        }
        if (hold) await new Promise<void>((r) => held.push(r));
        order.push(k.slice(k.lastIndexOf("/") + 1));
      }
      return mem.put(k, b, c, a);
    },
  };
  return {
    store,
    mem,
    order,
    held,
    hold: (on: boolean) => (hold = on),
    failNext: (n: number) => (failNext = n),
    releaseAll: () => {
      for (const r of held.splice(0)) r();
    },
  };
}

/** A shipper whose followers confirm every segment at once (or fail, on demand). */
function fleet(confirm: "ok" | "fail" = "ok") {
  const shipped: { txid: number; uploaded: boolean }[] = [];
  const shipper: SegmentShipper = {
    ship(seg) {
      const row = { txid: seg.txid, uploaded: false };
      shipped.push(row);
      return {
        confirmed:
          confirm === "ok" ? Promise.resolve() : Promise.reject(new Error("member failed")),
        uploaded: () => (row.uploaded = true),
      };
    },
  };
  return { shipper, shipped };
}

const image = (n: number) => {
  // a one-page SQLite-like image whose first page carries n
  const b = new Uint8Array(4096);
  b.set(new TextEncoder().encode("SQLite format 3\0"));
  b[16] = 0x10; // page size 4096
  b[17] = 0x00;
  b[100] = n;
  return b;
};

async function setup(confirm: "ok" | "fail" = "ok") {
  const s = slowStore();
  const b = celldBucket(s.store, { node: "lead", leaseTtlMs: 5_000 });
  const f = fleet(confirm);
  b.setShipper(f.shipper);
  const lease = await b.ownership.tryAcquire(cellKey);
  return { ...s, b, f, lease: lease!, epoch: lease!.epoch };
}

describe("P53 a leader's commits: followers or the bucket, whichever is first", () => {
  it("a commit the followers hold is acknowledged before its upload lands; uploads land in TXID order", async () => {
    const t = await setup();
    try {
      t.hold(true);
      for (let n = 1; n <= 3; n++)
        await t.b.durability.committed(cellKey, { seq: n, image: image(n), epoch: t.epoch });
      expect(t.held.length).toBe(1); // the first upload is on its way; the others wait behind it
      expect(t.f.shipped.map((r) => r.txid)).toEqual([1, 2, 3]);
      expect(t.f.shipped.every((r) => !r.uploaded)).toBe(true);
      t.hold(false);
      t.releaseAll();
      for (let i = 0; i < 50 && t.order.length < 3; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(t.order).toEqual([
        "0000000000000001-0000000000000001.ltx",
        "0000000000000002-0000000000000002.ltx",
        "0000000000000003-0000000000000003.ltx",
      ]);
      expect(t.f.shipped.every((r) => r.uploaded)).toBe(true);
    } finally {
      t.hold(false);
      t.releaseAll();
      await t.b.close();
    }
  });

  it("an upload that fails after the followers confirmed is retried until it lands", async () => {
    const t = await setup();
    try {
      t.failNext(2);
      await t.b.durability.committed(cellKey, { seq: 1, image: image(1), epoch: t.epoch });
      for (let i = 0; i < 100 && t.order.length < 1; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(t.order).toEqual(["0000000000000001-0000000000000001.ltx"]);
    } finally {
      await t.b.close();
    }
  });

  it("with the followers failing, a commit waits for its upload, and fails with it", async () => {
    const t = await setup("fail");
    try {
      await t.b.durability.committed(cellKey, { seq: 1, image: image(1), epoch: t.epoch });
      expect(t.order).toEqual(["0000000000000001-0000000000000001.ltx"]);
      t.failNext(1);
      await expect(
        t.b.durability.committed(cellKey, { seq: 2, image: image(2), epoch: t.epoch }),
      ).rejects.toThrow(/bucket unavailable/);
    } finally {
      await t.b.close();
    }
  });

  it("a cell is released only once its segments are in the bucket", async () => {
    const t = await setup();
    try {
      t.hold(true);
      await t.b.durability.committed(cellKey, { seq: 1, image: image(1), epoch: t.epoch });
      const released = t.lease.release();
      await new Promise((r) => setTimeout(r, 50));
      const own = JSON.parse(
        new TextDecoder().decode((await t.mem.get(`cells/${scope}/own.json`))!.body),
      );
      expect(own.node).toBe("lead"); // still ours: the upload has not landed
      t.hold(false);
      t.releaseAll();
      await released;
      const after = JSON.parse(
        new TextDecoder().decode((await t.mem.get(`cells/${scope}/own.json`))!.body),
      );
      expect(after.node).toBe("");
      expect(t.order).toEqual(["0000000000000001-0000000000000001.ltx"]);
    } finally {
      t.hold(false);
      t.releaseAll();
      await t.b.close();
    }
  });
});

// Merge gate #213, pass 1 (high): an upload that gave up (the node's authority lapsed while the
// bucket failed) did not stop the next one: the bucket got TXID N+1 without N, and recovery (cellb's
// and celld's) skips rows at or below the highest TXID it lists — N was lost for good.
describe("P53 a cell's uploads after one that gave up", () => {
  it("leave no TXID gap in the bucket", async () => {
    const { ltxLog } = await import("../src/bucket/ltx-log.js");
    const mem = memoryObjectStore();
    let failTxid1 = true;
    const store: ObjectStore = {
      get: (k) => mem.get(k),
      list: (p) => mem.list(p),
      delete: (k) => mem.delete(k),
      put: async (k, b, c, a) => {
        if (failTxid1 && k.endsWith("0000000000000001-0000000000000001.ltx"))
          throw new Error("bucket unavailable");
        return mem.put(k, b, c, a);
      },
    };
    let authorized = true;
    const log = ltxLog(store, { authorized: () => authorized });
    log.setShipper(fleet().shipper);
    log.begin(cellKey, 1);
    await log.committed(cellKey, { seq: 1, image: image(1), epoch: 1 }); // the followers hold it
    authorized = false; // the lease lapses: the failing upload of TXID 1 gives up
    await new Promise((r) => setTimeout(r, 300));
    authorized = true; // renewed
    failTxid1 = false;
    await log.committed(cellKey, { seq: 2, image: image(2), epoch: 1 });
    await log.flush(cellKey);
    // an upload the followers acknowledged never gives up (writing into a superseded epoch is
    // harmless): once the bucket answers, both land, in order — never 2 without 1
    expect(await mem.list(`cells/${scope}/ltx/`)).toEqual([
      `cells/${scope}/ltx/e1/0000/0000000000000001-0000000000000001.ltx`,
      `cells/${scope}/ltx/e1/0000/0000000000000002-0000000000000002.ltx`,
    ]);
  }, 20_000);
});

// Merge gate #213, pass 1 (high): release() swallowed an upload that had not landed and wrote the
// record released ({node: ""}), so the next owner took the cell at once and restored from a bucket
// missing a segment the followers had acknowledged; the takeover gate (which waits for a dead
// owner's session to be recovered) never saw it.
describe("P53 releasing a cell whose acknowledged segment is not in the bucket", () => {
  it("keeps the record naming this node (recovery decides), and takes the cell again only once it landed", async () => {
    const t = await setup();
    try {
      t.failNext(1_000_000); // the bucket is down for cell files
      await t.b.durability.committed(cellKey, { seq: 1, image: image(1), epoch: t.epoch });
      await t.lease.release();
      const own = JSON.parse(
        new TextDecoder().decode((await t.mem.get(`cells/${scope}/own.json`))!.body),
      );
      expect(own.node).toBe("lead");
      t.failNext(0); // the bucket is back: the retried upload lands
      const again = await t.b.ownership.tryAcquire(cellKey); // waits for it first
      expect(again?.epoch).toBe(t.epoch + 1);
      expect(t.order).toEqual(["0000000000000001-0000000000000001.ltx"]);
    } finally {
      await t.b.close();
    }
  }, 30_000);
});

// Merge gate #213, pass 2 (high): an acknowledged upload retried for ever, even once its bucket was
// closed: a node shutting down while the bucket was down never exited. It stops when the bucket
// closes, and nothing of the cell queued after it lands (no gap): the session stays unsealed and
// recovery brings the rows back from the followers.
describe("P53 shutting down while an acknowledged upload cannot land", () => {
  it("stops retrying once the bucket closes, and lands nothing after it", async () => {
    const { ltxLog } = await import("../src/bucket/ltx-log.js");
    const mem = memoryObjectStore();
    let down = true;
    const store: ObjectStore = {
      get: (k) => mem.get(k),
      list: (p) => mem.list(p),
      delete: (k) => mem.delete(k),
      put: async (k, b, c, a) => {
        if (down && k.includes("/ltx/") && k.endsWith("0000000000000001-0000000000000001.ltx"))
          throw new Error("bucket unavailable");
        return mem.put(k, b, c, a);
      },
    };
    let stopped = false;
    const log = ltxLog(store, { stopped: () => stopped });
    log.setShipper(fleet().shipper);
    log.begin(cellKey, 1);
    await log.committed(cellKey, { seq: 1, image: image(1), epoch: 1 }); // followers hold it
    await log.committed(cellKey, { seq: 2, image: image(2), epoch: 1 }); // queued behind it
    stopped = true; // the bucket closes
    expect(await log.flush(cellKey, 5_000)).toBe(true); // the retries end
    down = false;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(await mem.list(`cells/${scope}/ltx/`)).toEqual([]); // not 2 without 1
  }, 20_000);
});

// Merge gate #213, pass 2 (high): taking a cell waited without bound for its segments still on
// their way, before checking the lease: with the bucket down, the request hung.
describe("P53 taking a cell whose segments cannot land", () => {
  it("fails within a lease instead of waiting for the bucket", async () => {
    const t = await setup();
    try {
      t.failNext(1_000_000);
      await t.b.durability.committed(cellKey, { seq: 1, image: image(1), epoch: t.epoch });
      await t.lease.release(); // keeps the record (the segment is not in the bucket)
      const t0 = Date.now();
      await expect(t.b.ownership.tryAcquire(cellKey)).rejects.toThrow(/on their way/);
      expect(Date.now() - t0).toBeLessThan(5_000 + 1_500); // at most a lease (setup: 5 s)
    } finally {
      t.failNext(0);
      await t.b.close();
    }
  }, 30_000);
});
