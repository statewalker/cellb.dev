import { describe, expect, it } from "vitest";
import { celldBucket, memoryObjectStore, type ObjectStore } from "../src/index.js";

// A clean shutdown gives the node's cells up at once: `close()` removes the node's lease record,
// so the next node takes the cells without waiting for the lease to run out. A renewal that was
// on its way to the bucket when `close()` ran must not write the record back after the delete:
// the cells would then stay "owned by a live node" for a whole lease.
describe("P10h a closed node's lease", () => {
  const cell = `Agent/${"c".repeat(64)}`;

  /** A store whose writes of node records wait until `release()`, once `hold` is set. */
  function slowLeases(): {
    store: ObjectStore;
    hold(): void;
    held(): Promise<void>;
    release(): void;
  } {
    const inner = memoryObjectStore();
    let holding = false;
    const waiting: Array<() => void> = [];
    let arrived: () => void = () => {};
    let arrival = new Promise<void>((r) => (arrived = r));
    const store: ObjectStore = {
      get: (k) => inner.get(k),
      list: (p) => inner.list(p),
      delete: (k) => inner.delete(k),
      async put(key, body, cond, attrs) {
        if (holding && key.startsWith("nodes/")) {
          arrived();
          await new Promise<void>((r) => waiting.push(r));
        }
        return inner.put(key, body, cond, attrs);
      },
    };
    return {
      store,
      hold: () => {
        holding = true;
        arrival = new Promise<void>((r) => (arrived = r));
      },
      held: () => arrival,
      release: () => {
        holding = false;
        for (const r of waiting.splice(0)) r();
      },
    };
  }

  it("a renewal in flight at close() does not bring the record back", async () => {
    const s = slowLeases();
    const a = celldBucket(s.store, { node: "a", leaseTtlMs: 300 });
    expect(await a.ownership.tryAcquire(cell)).toBeDefined();
    s.hold();
    await s.held(); // the next renewal is on its way to the bucket
    const closed = a.close();
    s.release();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.store.get("nodes/a.json")).toBeUndefined();
    // So the next node takes the cell now, not once a's lease has run out.
    const b = celldBucket(s.store, { node: "b", leaseTtlMs: 60_000 });
    expect(await b.ownership.tryAcquire(cell)).toBeDefined();
    await b.close();
  });

  it("no renewal starts after close()", async () => {
    const s = slowLeases();
    const a = celldBucket(s.store, { node: "a", leaseTtlMs: 150 });
    expect(await a.ownership.tryAcquire(cell)).toBeDefined();
    await a.close();
    await new Promise((r) => setTimeout(r, 300)); // two renewal periods
    expect(await s.store.get("nodes/a.json")).toBeUndefined();
  });
  /** A store whose node-record writes each wait for their own release, in any order. */
  function heldLeases() {
    const inner = memoryObjectStore();
    let holding = false;
    const held: Array<() => void> = [];
    let onHeld: () => void = () => {};
    const store: ObjectStore = {
      get: (k) => inner.get(k),
      list: (p) => inner.list(p),
      delete: (k) => inner.delete(k),
      async put(key, body, cond, attrs) {
        if (holding && key.startsWith("nodes/")) {
          await new Promise<void>((r) => {
            held.push(r);
            onHeld();
          });
        }
        return inner.put(key, body, cond, attrs);
      },
    };
    const heldCount = (n: number) =>
      new Promise<void>((r) => {
        onHeld = () => held.length >= n && r();
        onHeld();
      });
    return { store, hold: () => (holding = true), held, heldCount };
  }

  it("two lease writes in flight at close(), landing out of order, leave no record", async () => {
    const s = heldLeases();
    const a = celldBucket(s.store, { node: "a", leaseTtlMs: 300 });
    expect(await a.ownership.tryAcquire(cell)).toBeDefined();
    s.hold();
    await s.heldCount(1); // a renewal on its way
    void a.advertise("addr-2");
    await s.heldCount(2); // and the advertise's write after it
    const closed = a.close();
    s.held[1]?.(); // the later write lands first...
    await new Promise((r) => setTimeout(r, 20));
    s.held[0]?.(); // ...the earlier one last
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.store.get("nodes/a.json")).toBeUndefined();
  });

  it("close() returns within a lease even when a lease write never lands", async () => {
    const s = heldLeases();
    const a = celldBucket(s.store, { node: "a", leaseTtlMs: 300 });
    expect(await a.ownership.tryAcquire(cell)).toBeDefined();
    s.hold();
    await s.heldCount(1);
    const t0 = Date.now();
    await a.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a closed bucket acknowledges no more writes", async () => {
    const a = celldBucket(memoryObjectStore(), { node: "a", leaseTtlMs: 60_000 });
    expect(await a.ownership.tryAcquire(cell)).toBeDefined();
    await a.close();
    await expect(
      a.durability.logCommit(cell, { epoch: 1 } as Parameters<typeof a.durability.logCommit>[1]),
    ).rejects.toThrow(/self-fencing/);
  });
});
