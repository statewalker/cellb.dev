import { describe, expect, it } from "vitest";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { memoryObjectStore } from "../src/bucket/object-store.js";

// celld's wake index (logic/wake.rs): one immutable entry per alarm installation, a
// per-cell retirement certificate, and cleanup of everything the certificate retires.
describe("P11h wake index hygiene", () => {
  it("a replaced alarm leaves only its replacement; a consumed one leaves nothing to wake", async () => {
    const store = memoryObjectStore();
    const b = celldBucket(store, { node: "n1" });
    const cell = "Agent/" + "a".repeat(64);
    await b.durability.publishWake!(cell, { epoch: 2, sequence: 1, at: 1_800_000_000_000 });
    await b.durability.publishWake!(cell, { epoch: 2, sequence: 2, at: 1_800_000_060_000 });
    let entries = await store.list("wake/entries/");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/0000000000000002-0000000000000002$/);
    expect(await b.durability.wakes!()).toEqual([
      { cellKey: cell, className: "Agent", at: 1_800_000_060_000 },
    ]);
    // the handler consumed it: sequence 3, no alarm
    await b.durability.publishWake!(cell, { epoch: 2, sequence: 3, at: null });
    entries = await store.list("wake/entries/");
    expect(entries).toEqual([]);
    expect(await b.durability.wakes!()).toEqual([]);
    const retired = JSON.parse(
      new TextDecoder().decode(
        (await store.get(`wake/retired/Agent:${"a".repeat(64)}.json`))!.body,
      ),
    );
    expect(retired).toEqual({
      format: 2,
      identity: "0000000000000002-0000000000000003",
      at_ms: null,
    });
    await b.close();
  });
});
