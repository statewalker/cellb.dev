import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  CellOwnedElsewhereError,
  type CellRuntime,
  createCellRuntime,
  DurableObject,
  DurableObjectRoutingError,
  filesApiChangeLog,
  type Lease,
} from "../src/index.js";
import { nodeSqliteOpener } from "../src/node.js";
import { MemoryLeases } from "./memory-lease.js";

// Found by the hybrid celld + cellb cluster prototype (statewalker/cellb.dev#208): requests
// that reach a node at the same time for a cell another node owns must all go to the owner.
class Counter extends DurableObject {
  async fetch() {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
  async inc() {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}

/** A bucket's conditional write takes a while: acquisitions overlap with other requests. */
const slow = (lease: Lease): Lease => ({
  tryAcquire: async (key) => {
    await new Promise((r) => setTimeout(r, 20));
    return lease.tryAcquire(key);
  },
});

const sqlite = nodeSqliteOpener();
/** Local databases each node opened (a node routing to the owner should not open one per call). */
const opens = new Map<string, number>();
const dead = new Set<string>();
const gone = new Set<string>();
let staleOwner: string | undefined;
function fleet() {
  const leases = new MemoryLeases();
  const log = filesApiChangeLog(new MemFilesApi());
  const nodes = new Map<string, CellRuntime>();
  const node = (name: string) => {
    const rt = createCellRuntime({
      worker: {
        Counter,
        default: { fetch: (req: Request, env: any) => env.COUNTER.getByName("shared").fetch(req) },
      },
      durableObjects: { COUNTER: { className: "Counter" } },
      openSql: (cellKey: string) => {
        if (cellKey.startsWith("Counter/")) opens.set(name, (opens.get(name) ?? 0) + 1);
        return sqlite(cellKey);
      },
      storage: { ...log, ownership: slow(leases.for(name)) },
      peers: {
        // The owner's runtime, in process: a stand-in for the peer tunnel.
        link: (owner) => {
          // celldPeers reaches owners through endpoint() only: link() means no live node record
          if (gone.has(owner)) throw new DurableObjectRoutingError(owner, { ownerGone: true });
          return (req) => nodes.get(owner)!.fetch(req);
        },
        ownerOf: (cellKey) => Promise.resolve(staleOwner ?? leases.holder(cellKey)),
        endpoint: async (owner) => {
          if (gone.has(owner)) return undefined; // no live node record: as celldPeers answers
          if (dead.has(owner)) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
          const ns = nodes.get(owner)!.env.COUNTER as any;
          const stub = ns.getByName("shared");
          // as the peer server answers: a node that closed the cell no longer owns it (stale-owner)
          const stale = (e: unknown) => {
            throw (e as Error)?.name === "ObjectClosedError"
              ? new CellOwnedElsewhereError("Counter/shared")
              : e;
          };
          return {
            fetch: (req: Request) => stub.fetch(req).catch(stale),
            call: (method: string, args: unknown[]) => stub[method](...args).catch(stale),
          };
        },
      },
    });
    nodes.set(name, rt);
    return rt;
  };
  return { node, leases, nodes };
}

describe("P10j concurrent requests for a cell another node owns", () => {
  it("every concurrent fetch on a non-owner reaches the owner (none fails as closed)", async () => {
    const { node } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      const answers = await Promise.all(
        Array.from({ length: 16 }, async () => {
          const r = await b.fetch(new Request("http://app/"));
          return r.status === 200 ? ((await r.json()) as { n: number }).n : await r.text();
        }),
      );
      expect(answers.filter((x) => typeof x !== "number")).toEqual([]);
      expect([...answers].sort((x, y) => (x as number) - (y as number))).toEqual(
        Array.from({ length: 16 }, (_, i) => i + 2),
      );
    } finally {
      await b.close();
      await a.close();
    }
  });

  it("every concurrent RPC on a non-owner reaches the owner", async () => {
    const { node } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (a.env.COUNTER as any).getByName("shared").inc()).toBe(1);
      const ns = b.env.COUNTER as any;
      const got = await Promise.allSettled(
        Array.from({ length: 16 }, () => ns.getByName("shared").inc()),
      );
      expect(
        got.filter((g) => g.status === "rejected").map((g) => String((g as any).reason)),
      ).toEqual([]);
    } finally {
      await b.close();
      await a.close();
    }
  });

  it("while a dead owner's lease runs out, concurrent requests fail as unreachable, then the cell moves", async () => {
    const { node, leases } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      dead.add("A"); // A's process died; its lease is still live in the bucket
      const errors: string[] = [];
      const ns: number[] = [];
      let stop = false;
      const client = async () => {
        while (!stop) {
          const r = await b.fetch(new Request("http://app/"));
          const text = await r.text();
          if (r.status === 200) ns.push(JSON.parse(text).n);
          else errors.push(text);
          await new Promise((res) => setTimeout(res, 2));
        }
      };
      const clients = Array.from({ length: 8 }, client);
      await new Promise((r) => setTimeout(r, 150));
      leases.partition("A"); // A's lease expires: the cell is free
      await new Promise((r) => setTimeout(r, 300));
      stop = true;
      await Promise.all(clients);
      // Before the lease runs out: only "the owner is unreachable" errors. Afterwards B owns it.
      expect(errors.filter((e) => !/owner is currently unreachable/.test(e))).toEqual([]);
      expect(ns.length).toBeGreaterThan(0);
      expect(new Set(ns).size).toBe(ns.length);
      expect(Math.min(...ns)).toBe(2);
    } finally {
      dead.delete("A");
      await b.close();
      await a.close().catch(() => {});
    }
  });

  it("requests arriving one by one while the open fails are all rerouted (none fails as closed)", async () => {
    const { node } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      const pending: Promise<number | string>[] = [];
      for (let i = 0; i < 60; i++) {
        pending.push(
          b
            .fetch(new Request("http://app/"))
            .then(async (r) =>
              r.status === 200 ? ((await r.json()) as { n: number }).n : await r.text(),
            ),
        );
        await new Promise((r) => setTimeout(r, 1));
      }
      const answers = await Promise.all(pending);
      expect(answers.filter((x) => typeof x !== "number")).toEqual([]);
    } finally {
      await b.close();
      await a.close();
    }
  });

  it("an owner that left between the lookup and the call: the cell is claimed here", async () => {
    const { node } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      // b's lookup still names A (read before A released), but A has left: no node record.
      staleOwner = "A";
      gone.add("A");
      const releasedSoon = (async () => {
        await new Promise((r) => setTimeout(r, 30));
        await a.close(); // releases the cell
        staleOwner = undefined;
      })();
      const r = await b.fetch(new Request("http://app/"));
      await releasedSoon;
      expect(r.status, await r.clone().text()).toBe(200);
      expect(((await r.json()) as { n: number }).n).toBe(2);
    } finally {
      staleOwner = undefined;
      gone.delete("A");
      await b.close();
      await a.close();
    }
  });

  // A non-owner opened (and deleted) a local database for every call it routed, before finding
  // the cell owned elsewhere: 16 % of a cellb node's CPU when nodes route to each other
  // (bench/cluster-bench.mjs). Once it knows the owner, it calls the owner directly.
  it("a node that routes to the owner does not open the cell locally on every call", async () => {
    const { node } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      opens.set("B", 0);
      for (let i = 2; i <= 21; i++)
        expect(await (await b.fetch(new Request("http://app/"))).json()).toEqual({ n: i });
      expect(opens.get("B")).toBeLessThanOrEqual(1);
      // the owner leaves: B's next call finds out and takes the cell
      await a.close();
      expect(await (await b.fetch(new Request("http://app/"))).json()).toEqual({ n: 22 });
    } finally {
      await b.close();
      await a.close();
    }
  });

  // Reviewer finding (gate pass 1, #211): a node used the route it cached even after it took the
  // cell itself (an alarm, runInDurableObject), and a node serving a forwarded call routed it
  // again: two nodes forwarded the call to each other and it never ran.
  it("a node that owns the cell serves it, whatever route it cached; no forwarding loop", async () => {
    const { node, leases } = fleet();
    const a = node("A");
    const b = node("B");
    try {
      expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1 });
      expect(await (await b.fetch(new Request("http://app/"))).json()).toEqual({ n: 2 }); // B: route → A
      const cellKey = `Counter/${(b.env.COUNTER as any).idFromName("shared")}`;
      leases.expire(cellKey); // A's lease runs out; A stays up
      const { runInDurableObject } = await import("../src/index.js");
      // B takes the cell without a routed call (as an alarm firing does)
      expect(
        await runInDurableObject(
          (b.env.COUNTER as any).getByName("shared"),
          async (_o: unknown, s: any) => s.storage.get("n"),
        ),
      ).toBe(2);
      const r = await Promise.race([
        b.fetch(new Request("http://app/")).then((x) => x.json()),
        new Promise((res) => setTimeout(() => res("timed out: forwarding loop"), 3_000)),
      ]);
      expect(r).toEqual({ n: 3 });
    } finally {
      await b.close();
      await a.close();
    }
  });
});
