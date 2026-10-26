import { describe, expect, it } from "vitest";
import { CellRouter } from "../src/index.js";
import { shardOwner } from "../src/project/browser-tabs.js";
import { H } from "../src/transport/cells-link.js";

// The parts of a project shared by tabs that need no browser: which tab runs which shard, and
// the router's hand-over of a shard (joinProjectShards and installProjectRouter use both).

describe("P05d shards split over the tabs", () => {
  const tabs = (n: number) => Array.from({ length: n }, (_, i) => `00${i}-tab`);
  const split = (shards: number, present: string[]) => {
    const count = new Map<string, number>();
    for (let s = 0; s < shards; s++) {
      const owner = shardOwner(s, present)!;
      count.set(owner, (count.get(owner) ?? 0) + 1);
    }
    return present.map((t) => count.get(t) ?? 0);
  };

  it("gives every tab ⌊shards/n⌋ or ⌈shards/n⌉ shards, the oldest tabs the extra ones", () => {
    expect(split(4, tabs(1))).toEqual([4]);
    expect(split(4, tabs(2))).toEqual([2, 2]);
    expect(split(4, tabs(3))).toEqual([2, 1, 1]);
    expect(split(4, tabs(5))).toEqual([1, 1, 1, 1, 0]);
    expect(split(7, tabs(3))).toEqual([3, 2, 2]);
  });

  it("is the same in every tab, whatever order each lists the tabs in", () => {
    const t = tabs(3);
    for (let s = 0; s < 6; s++) expect(shardOwner(s, [t[2], t[0], t[1]])).toBe(shardOwner(s, t));
    expect(shardOwner(0, [])).toBeUndefined();
  });
});

describe("P05d the router of a project shared by tabs", () => {
  const ok = (body: string) => async () => new Response(body);

  it("sends an internal request to the shard its sender named", async () => {
    const router = new CellRouter({ shards: 2, bindings: {} });
    router.attach(0, ok("zero"));
    router.attach(1, ok("one"));
    const req = new Request("http://cellb.internal/", {
      headers: { [H.kind]: "fetch", [H.binding]: "__CELLS_KV_OBJECTS", [H.shard]: "1" },
    });
    expect(await (await router.internal(req)).text()).toBe("one");
  });

  it("drains a shard: requests in flight finish, new ones wait for the next owner", async () => {
    const router = new CellRouter({ shards: 1, bindings: {}, attachTimeoutMs: 2_000 });
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    router.attach(0, async () => (await slow, new Response("old")), "owner-1");
    const inFlight = router.ingress(new Request("http://x/"));
    await new Promise((r) => setTimeout(r, 10));
    const draining = router.drain(0, "owner-1", 1_000);
    const waiting = router.ingress(new Request("http://x/")); // after the drain began
    finish();
    expect(await (await inFlight).text()).toBe("old");
    await draining;
    router.attach(0, ok("new"), "owner-2");
    expect(await (await waiting).text()).toBe("new");
  });

  it("drains only the owner it was asked for", async () => {
    const router = new CellRouter({ shards: 1, bindings: {} });
    router.attach(0, ok("current"), "owner-2");
    await router.drain(0, "owner-1", 100); // a stale request from the previous owner
    expect(router.attachedShards).toEqual([0]);
    expect(await (await router.ingress(new Request("http://x/"))).text()).toBe("current");
  });
});
