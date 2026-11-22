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
