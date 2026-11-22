import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  type CellRuntime,
  createCellRuntime,
  DurableObject,
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

const dead = new Set<string>();
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
      openSql: nodeSqliteOpener(),
      storage: { ...log, ownership: slow(leases.for(name)) },
      peers: {
        ownerOf: (cellKey) => Promise.resolve(leases.holder(cellKey)),
        // The owner's runtime, in process: a stand-in for the peer tunnel.
        link: (owner) => (req) => nodes.get(owner)!.fetch(req),
        endpoint: async (owner) => {
          if (dead.has(owner)) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
          const ns = nodes.get(owner)!.env.COUNTER as any;
          const stub = ns.getByName("shared");
          return {
            fetch: (req: Request) => stub.fetch(req),
            call: (method: string, args: unknown[]) => stub[method](...args),
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
});
