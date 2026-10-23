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

  it("waker role: own cells always; unowned or dead-owner cells by the elected waker; a live owner's only after its lease", async () => {
    const store = memoryObjectStore();
    const a = celldBucket(store, { node: "a" });
    const b = celldBucket(store, { node: "b" });
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const cell = (c: string) => `Agent/${c.repeat(64)}`;
    const at = Date.now() + 60_000;
    // ownership: 1 → a, 2 → b (live), 3 → nobody, 4 → dead node "z"
    await store.put(`cells/Agent:${"1".repeat(64)}/own.json`, enc({ node: "a", epoch: 1 }));
    await store.put(`cells/Agent:${"2".repeat(64)}/own.json`, enc({ node: "b", epoch: 1 }));
    await store.put(`cells/Agent:${"4".repeat(64)}/own.json`, enc({ node: "z", epoch: 1 }));
    await store.put("nodes/a.json", enc({ node: "a", expires_ms: Date.now() + 60_000 }));
    await store.put("nodes/b.json", enc({ node: "b", expires_ms: Date.now() + 120_000 }));
    await store.put("nodes/z.json", enc({ node: "z", expires_ms: Date.now() - 1 }));
    for (const c of ["1", "2", "3", "4"])
      await a.durability.publishWake!(cell(c), { epoch: 1, sequence: 1, at });
    const keys = (ws: { cellKey: string }[]) => ws.map((w) => w.cellKey[6]).sort();
    const fromA = await a.durability.wakes!(); // a holds the waker role now
    expect(keys(fromA)).toEqual(["1", "2", "3", "4"]);
    // b's live cell: the waker only looks again once b's lease would have run out
    expect(fromA.find((w) => w.cellKey === cell("2"))!.at).toBeGreaterThan(at);
    expect(keys(await b.durability.wakes!())).toEqual(["2"]); // b: only its own (a is the waker)
    await a.close();
    await b.close();
  });
});
