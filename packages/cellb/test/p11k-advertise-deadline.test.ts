import { describe, expect, it } from "vitest";
import { celldBucket, memoryObjectStore, type ObjectStore } from "../src/index.js";

// statewalker/cellb.dev#178: advertise() rewrites the node lease, moving its validity forward,
// but did not re-arm the deadline timer. When the renewals after it stop landing, the deadline
// had already fired at the older time and found the lease still valid, so the node's cells were
// never fenced. Hybrid fleets advertise after the first cell is taken (a peer server that starts
// after the runtime), so the window is no longer only at setup.
describe("P11k a node lease rewritten by advertise() is still fenced at its deadline", () => {
  it("the cell's lease is lost once the advertised validity runs out", async () => {
    const mem = memoryObjectStore();
    let hang = false;
    const store: ObjectStore = {
      get: (k) => mem.get(k),
      list: (p) => mem.list(p),
      delete: (k) => mem.delete(k),
      put: (k, b, c, a) =>
        hang && k.startsWith("nodes/") ? new Promise<string>(() => {}) : mem.put(k, b, c, a),
    };
    const ttl = 1_000;
    const bucket = celldBucket(store, { node: "n", leaseTtlMs: ttl });
    const lease = await bucket.ownership.tryAcquire(`Counter/${"1".repeat(64)}`);
    expect(lease).toBeTruthy();
    // Between two renewals (every ttl/3), the address is published; then renewals hang.
    await new Promise((r) => setTimeout(r, ttl / 3 + ttl / 6));
    await bucket.advertise("127.0.0.1:1234");
    hang = true;
    const t = Date.now();
    const fenced = await new Promise<boolean>((resolve) => {
      if (lease!.lost.aborted) return resolve(true);
      lease!.lost.addEventListener("abort", () => resolve(true));
      setTimeout(() => resolve(false), 3 * ttl);
    });
    expect(fenced).toBe(true);
    // no later than the advertised record's validity (ttl minus a margin), give or take timers
    expect(Date.now() - t).toBeLessThan(ttl + 250);
    hang = false;
    await bucket.close();
  });
});

// A deadline timer can fire a little before the clock the lease is judged by reads the deadline
// (Node timers round; a `now` that is not Date.now). It then found the lease still valid and was
// not armed again, and with renewals stuck the node kept its cells past its lease: a split brain
// waiting to happen (statewalker/cellb.dev#212, found by stressing p11i).
describe("P11k a deadline that fires early", () => {
  it("is armed again for the rest, and still fences the cells", async () => {
    const mem = memoryObjectStore();
    let hang = false;
    let lag = 0;
    const store: ObjectStore = {
      get: (k) => mem.get(k),
      list: (p) => mem.list(p),
      delete: (k) => mem.delete(k),
      put: (k, b, c, a) =>
        hang && k.startsWith("nodes/") ? new Promise<string>(() => {}) : mem.put(k, b, c, a),
    };
    const ttl = 1_000;
    const bucket = celldBucket(store, { node: "n", leaseTtlMs: ttl, now: () => Date.now() - lag });
    const lease = await bucket.ownership.tryAcquire(`Counter/${"5".repeat(64)}`);
    hang = true; // no renewal lands from now on
    lag = 150; // when the deadline timer fires, the lease's clock reads 150 ms short of it
    const fenced = await new Promise<boolean>((resolve) => {
      if (lease!.lost.aborted) return resolve(true);
      lease!.lost.addEventListener("abort", () => resolve(true));
      setTimeout(() => resolve(false), 4 * ttl);
    });
    expect(fenced).toBe(true);
    hang = false;
    await bucket.close();
  });
});
