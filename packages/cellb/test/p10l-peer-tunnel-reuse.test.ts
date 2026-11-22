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

describe("P10l peer tunnels are reused", () => {
  it("sequential calls to an owner share a tunnel (fetch and RPC)", async () => {
    const store = memoryObjectStore();
    const worker = { Counter, default: {} };
    const owner = createCellRuntime({
      worker,
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: celldBucket(store, { node: "owner" }),
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner" });
    const relay = await countingRelay(peer.addr);
    await store.put(
      "nodes/owner.json",
      new TextEncoder().encode(
        JSON.stringify({ node: "owner", addr: relay.addr, expires_ms: Date.now() + 60_000 }),
      ),
    );
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
    const owner = createCellRuntime({
      worker: { Counter, default: {} },
      durableObjects: { C: { className: "Counter" } },
      openSql: nodeSqliteOpener(),
      storage: celldBucket(store, { node: "owner2" }),
    });
    const peer = await startCelldPeerServer({ runtime: owner, store, node: "owner2" });
    await store.put(
      "nodes/owner2.json",
      new TextEncoder().encode(
        JSON.stringify({ node: "owner2", addr: peer.addr, expires_ms: Date.now() + 60_000 }),
      ),
    );
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
});
