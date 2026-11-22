import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { celldBucket, createCellRuntime, DurableObject, memoryObjectStore } from "../src/index.js";
import { celldPeers, nodeSqliteOpener, startCelldPeerServer } from "../src/node.js";

// celld pools its peer tunnels and reuses an idle one for the next call (h1 keep-alive inside,
// main/peer_tunnel.rs): without that every call is a TCP connection and a tunnel upgrade, which
// halved a cellb cluster's throughput when its nodes routed to each other (bench/cluster-bench.mjs,
// statewalker/cellb.dev#208). Both sides: cellb's client reuses tunnels, and its server keeps
// them open for celld's.
class Counter extends DurableObject {
  /** Writes, waits, writes again: still running when its node closes, it fails half done. */
  async twoStep(ms: number) {
    this.inc();
    await new Promise((r) => setTimeout(r, ms));
    return this.inc();
  }
  async slow(ms: number) {
    await new Promise((r) => setTimeout(r, ms));
    return this.inc();
  }
  inc() {
    const n = ((this.ctx.storage.kv.get("n") as number | undefined) ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }
  async fetch() {
    return Response.json({ n: this.inc() });
  }
}

/** A TCP relay that counts the connections made through it. */
async function countingRelay(
  to: string,
): Promise<{ addr: string; count: () => number; close(): void }> {
  const [host, port] = [
    to.slice(0, to.lastIndexOf(":")),
    Number(to.slice(to.lastIndexOf(":") + 1)),
  ];
  let n = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((c) => {
    n++;
    const up = connect(port, host);
    sockets.add(c).add(up);
    c.pipe(up).pipe(c);
    c.on("error", () => up.destroy());
    up.on("error", () => c.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    addr: `127.0.0.1:${(server.address() as { port: number }).port}`,
    count: () => n,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

// Each owner's bucket: its address is published with advertise() (the record is written only
// through the node's own lease chain).
let bucket_owner: ReturnType<typeof celldBucket>;
let bucket_owner2: ReturnType<typeof celldBucket>;
let bucket_owner3: ReturnType<typeof celldBucket>;
let bucket_owner4: ReturnType<typeof celldBucket>;

describe("P10l peer tunnels are reused", () => {
  it("sequential calls to an owner share a tunnel (fetch and RPC)", async () => {
    const store = memoryObjectStore();
    const worker = { Counter, default: {} };
    bucket_owner = celldBucket(store, { node: "owner" });
    const owner = createCellRuntime({
      worker,
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: bucket_owner,
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner" });
    const relay = await countingRelay(peer.addr);
    await (await bucket_owner.ownership.tryAcquire("C/warm-owner"))?.release();
    await bucket_owner.advertise(relay.addr);
    const cellKey = `Counter/${(owner.env.C as any).idFromName("x").toString()}`;
    const ep = (await celldPeers({ store, node: "caller" }).endpoint("owner", cellKey, "x"))!;
    try {
      for (let i = 1; i <= 10; i++)
        expect(await (await ep.fetch(new Request("http://w/"))).json()).toEqual({ n: i });
      for (let i = 11; i <= 20; i++) expect(await ep.call("inc", [])).toBe(i);
      expect(relay.count()).toBeLessThanOrEqual(2); // one `do` tunnel and one `rpc` tunnel
    } finally {
      relay.close();
      await peer.close();
      await owner.close();
    }
  });

  // A node leaving the fleet closed its peer server by destroying every tunnel, a call still on
  // its way back included: the caller saw "socket hang up" (p11k's graceful leave, in CI).
  it("closing the peer server lets the calls in flight on its tunnels finish", async () => {
    const store = memoryObjectStore();
    bucket_owner2 = celldBucket(store, { node: "owner2" });
    const owner = createCellRuntime({
      worker: { Counter, default: {} },
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: bucket_owner2,
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner2" });
    await (await bucket_owner2.ownership.tryAcquire("C/warm-owner2"))?.release();
    await bucket_owner2.advertise(peer.addr);
    const cellKey = `Counter/${(owner.env.C as any).idFromName("y").toString()}`;
    const ep = (await celldPeers({ store, node: "caller2" }).endpoint("owner2", cellKey, "y"))!;
    try {
      const inFlight = ep.call("slow", [300]);
      await new Promise((r) => setTimeout(r, 100));
      const closed = peer.close();
      expect(await inFlight).toBe(1);
      await closed;
    } finally {
      await peer.close();
      await owner.close();
    }
  });

  // Reviewer finding (gate pass 1, #211): ObjectClosedError also reaches an event that already
  // ran and wrote, when its node closes under it. Answering that as stale-owner made the caller
  // run the same call on the next owner: one call applied twice. Only a call that never started
  // may be re-routed.
  it("a call its owner closed while it ran is not answered as stale-owner (it is not re-run)", async () => {
    const { CellOwnedElsewhereError } = await import("../src/index.js");
    const store = memoryObjectStore();
    bucket_owner3 = celldBucket(store, { node: "owner3" });
    const owner = createCellRuntime({
      worker: { Counter, default: {} },
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: bucket_owner3,
      closeGraceMs: 50,
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner3" });
    await (await bucket_owner3.ownership.tryAcquire("C/warm-owner3"))?.release();
    await bucket_owner3.advertise(peer.addr);
    const cellKey = `Counter/${(owner.env.C as any).idFromName("z").toString()}`;
    const ep = (await celldPeers({ store, node: "caller3" }).endpoint("owner3", cellKey, "z"))!;
    try {
      const running = ep.call("twoStep", [400]).catch((e: any) => e);
      await new Promise((r) => setTimeout(r, 100));
      await owner.close(); // the event is half done when its database closes
      const err = (await running) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CellOwnedElsewhereError);
      expect(String(err.message)).not.toMatch(/owned by another node/);
    } finally {
      await peer.close();
      await owner.close();
    }
  });

  it("a call that reaches a closed node before it starts is answered as stale-owner", async () => {
    const store = memoryObjectStore();
    bucket_owner4 = celldBucket(store, { node: "owner4" });
    const owner = createCellRuntime({
      worker: { Counter, default: {} },
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: bucket_owner4,
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner4" });
    await (await bucket_owner4.ownership.tryAcquire("C/warm-owner4"))?.release();
    await bucket_owner4.advertise(peer.addr);
    const cellKey = `Counter/${(owner.env.C as any).idFromName("w").toString()}`;
    const ep = (await celldPeers({ store, node: "caller4" }).endpoint("owner4", cellKey, "w"))!;
    try {
      await owner.close();
      const refused = (await ep.call("inc", []).catch((e: unknown) => e)) as Error;
      expect(refused.name).toBe("CellOwnedElsewhereError");
    } finally {
      await peer.close();
    }
  });

  // celld serves a peer call only where it owns the cell; anywhere else it answers stale-owner
  // and the caller re-resolves. A cellb node routed a call it was handed to the owner it knew,
  // which can loop between two nodes (reviewer finding, gate pass 1, #211).
  it("a node handed a call for a cell it does not own answers stale-owner, never forwards it", async () => {
    const store = memoryObjectStore();
    const worker = { Counter, default: {} };
    const buckets = new Map<string, ReturnType<typeof celldBucket>>();
    const mk = (node: string) => {
      const bucket = celldBucket(store, { node });
      buckets.set(node, bucket);
      return createCellRuntime({
        worker,
        durableObjects: { C: { className: "Counter" } },
        openSql: nodeSqliteOpener(),
        storage: bucket,
        peers: celldPeers({ store, node }),
      });
    };
    const y = mk("y-owner");
    const x = mk("x-other");
    const py = await startCelldPeerServer({ runtime: y, store, node: "y-owner" });
    const px = await startCelldPeerServer({ runtime: x, store, node: "x-other" });
    for (const [n, p] of [
      ["y-owner", py],
      ["x-other", px],
    ] as const) {
      const b = buckets.get(n)!;
      await (await b.ownership.tryAcquire(`C/warm-${n}`))?.release();
      await b.advertise(p.addr);
    }
    try {
      expect(await (y.env.C as any).getByName("v").inc()).toBe(1); // y owns it
      const cellKey = `Counter/${(y.env.C as any).idFromName("v").toString()}`;
      // a caller that wrongly believes x owns the cell
      const ep = (await celldPeers({ store, node: "z" }).endpoint("x-other", cellKey, "v"))!;
      const err = (await ep.call("inc", []).catch((e: unknown) => e)) as Error;
      expect(err?.name).toBe("CellOwnedElsewhereError");
      expect(await (y.env.C as any).getByName("v").inc()).toBe(2); // ran nowhere else
    } finally {
      await px.close();
      await py.close();
      await x.close();
      await y.close();
    }
  });
});
