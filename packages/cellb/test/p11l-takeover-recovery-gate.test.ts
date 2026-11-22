import { describe, expect, it } from "vitest";
import { celldBucket, memoryObjectStore } from "../src/index.js";

// celld's takeover recovery gate (celld 0.6.3 docs/guarantees.md, logic/log_tier.rs
// takeover_gate): in CELLD_DURABILITY=fleet, the default, a celld node acknowledges writes once
// its followers hold them, before they reach cells/<cell>/ltx/. A node taking a cell from a
// dead celld owner must wait until that owner's node log is recovered: `log.state` in
// nodes/<owner>.json reads "sealed" (or there is no `log`). cellb took the cell at once and
// restored a stale generation, losing acknowledged writes (statewalker/cellb.dev#208).
const enc = new TextEncoder();
const cellKey = `Counter/${"2".repeat(64)}`;
const scope = `Counter:${"2".repeat(64)}`;

async function deadCelldOwner(log: Record<string, unknown> | undefined) {
  const store = memoryObjectStore();
  await store.put(`cells/${scope}/own.json`, enc.encode('{"node":"node_dead","epoch":3}'));
  await store.put(
    `cells/${scope}/ltx/e3/0000/0000000000000001-0000000000000001.ltx`,
    new Uint8Array(8),
  );
  const lease = {
    node: "node_dead",
    expires_ms: Date.now() - 1_000,
    addr: "127.0.0.1:9",
    ...(log ? { log } : {}),
  };
  await store.put("nodes/node_dead.json", enc.encode(JSON.stringify(lease)));
  return store;
}
const logOf = (state: string) => ({
  state,
  epoch: 8,
  ensemble: ["node_other"],
  tiered: 0,
  active: true,
  claimant: null,
  claimed_ms: null,
});

describe("P11l taking a cell from a dead celld owner waits for its node log", () => {
  for (const state of ["open", "recovering", "some-future-state"])
    it(`refuses while the dead owner's log is "${state}"`, async () => {
      const store = await deadCelldOwner(logOf(state));
      const b = celldBucket(store, { node: "cellb-1" });
      try {
        expect(await b.ownership.tryAcquire(cellKey)).toBeUndefined();
        const own = JSON.parse(
          new TextDecoder().decode((await store.get(`cells/${scope}/own.json`))!.body),
        );
        expect(own).toEqual({ node: "node_dead", epoch: 3 }); // untouched: recovery writes e3 first
      } finally {
        await b.close();
      }
    });

  for (const [label, log] of [
    ["sealed", logOf("sealed")],
    ["absent (never acknowledged past the bucket)", undefined],
  ] as const)
    it(`takes the cell once the log is ${label}`, async () => {
      const store = await deadCelldOwner(log);
      const b = celldBucket(store, { node: "cellb-1" });
      try {
        const lease = await b.ownership.tryAcquire(cellKey);
        expect(lease?.epoch).toBe(4);
      } finally {
        await b.close();
      }
    });
});

// celld's first-readiness gate (main.rs, logic/drain.rs fleet_status) keeps a starting celld node
// unready while any live peer reports memory pressure, and never fails open. cellb's record said
// `pressured: true, memory_headroom: false` (to be offered no cells), so a celld node started
// while a cellb node was live never became ready: a rolling deploy of celld stalled. Hand-offs
// and rebalancing already pass cellb by through `paced_handoff: false` (actor.rs
// handoff_exclusions, logic/rebalance.rs); a full celld node may route a new cell to it, which
// cellb serves (statewalker/cellb.dev#208).
describe("P11l the node record does not hold celld's readiness", () => {
  it("a node celld can reach reports headroom, no pressure, and no paced hand-off", async () => {
    const store = memoryObjectStore();
    const b = celldBucket(store, { node: "cellb-r" });
    try {
      await b.advertise("127.0.0.1:7000"); // its peer server
      await b.ownership.tryAcquire(`Counter/${"3".repeat(64)}`); // writes the node record
      const rec = JSON.parse(
        new TextDecoder().decode((await store.get("nodes/cellb-r.json"))!.body),
      );
      expect(rec.load).toMatchObject({ pressured: false, memory_headroom: true });
      expect(rec.paced_handoff).toBe(false);
      expect(rec.load.placement_weight).toBe(0);
    } finally {
      await b.close();
    }
  });

  it("a node celld cannot reach (a browser) still reports pressure: celld places no cell on it", async () => {
    const store = memoryObjectStore();
    const b = celldBucket(store, { node: "cellb-tab" });
    try {
      await b.ownership.tryAcquire(`Counter/${"4".repeat(64)}`);
      const rec = JSON.parse(
        new TextDecoder().decode((await store.get("nodes/cellb-tab.json"))!.body),
      );
      expect(rec.addr).toBe("cellb-tab.cellb.invalid:9");
      expect(rec.load).toMatchObject({ pressured: true, memory_headroom: false });
    } finally {
      await b.close();
    }
  });
});
