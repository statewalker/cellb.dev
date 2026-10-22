import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CasLease,
  type CellRuntime,
  cellsHttpHandler,
  createCellRuntime,
  DurableObject,
  filesApiChangeLog,
  MemoryConditionalStore,
} from "../src/index.js";

class Counter extends DurableObject {
  async fetch(req: Request) {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n, body: req.method === "POST" ? await req.text() : null });
  }
  async peek() {
    return (await this.ctx.storage.get<number>("n")) ?? 0;
  }
}

const SECRET = "fleet-secret";
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Serves a node's internal link (cellsHttpHandler) over node:http, guarded by a shared secret. */
async function serveLink(runtime: () => CellRuntime): Promise<string> {
  const server = createServer(async (req, res) => {
    if (req.headers["x-fleet-secret"] !== SECRET) return void res.writeHead(403).end();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await cellsHttpHandler(runtime())(
      new Request(`http://link${req.url}`, { method: req.method, headers, body }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("P10c routing between nodes (celld-style peer forwarding)", () => {
  it("a request on a node that does not own the cell is served by the owner; ownership moves on close", async () => {
    const files = new MemFilesApi();
    const store = new MemoryConditionalStore();
    const log = filesApiChangeLog(files);
    const addresses = new Map<string, string>();
    const nodes = new Map<string, CellRuntime>();
    const leases = new Map<string, CasLease>();
    const node = (name: string) => {
      const lease = new CasLease({
        store,
        owner: name,
        ttlMs: 10_000,
        renewEveryMs: 3_000,
        skewMarginMs: 1_000,
      });
      leases.set(name, lease);
      const rt = createCellRuntime({
        worker: {
          Counter,
          default: {
            fetch: (req: Request, env: any) => env.COUNTER.getByName("shared").fetch(req),
          },
        },
        durableObjects: { COUNTER: { className: "Counter" } },
        openSql: nodeSqliteOpener(),
        durability: log,
        backup: log,
        ownership: lease,
        peers: {
          ownerOf: (cellKey) => lease.holder(cellKey),
          link: (owner) => async (req) => {
            const headers = new Headers(req.headers);
            headers.set("x-fleet-secret", SECRET);
            const body = req.body ? await req.arrayBuffer() : undefined;
            return fetch(`${addresses.get(owner)}${new URL(req.url).pathname}`, {
              method: req.method,
              headers,
              body,
            });
          },
        },
      });
      nodes.set(name, rt);
      return rt;
    };
    const a = node("A");
    const b = node("B");
    addresses.set("A", await serveLink(() => a));
    addresses.set("B", await serveLink(() => b));

    // The first request lands on A: A takes the cell.
    expect(await (await a.fetch(new Request("http://app/"))).json()).toEqual({ n: 1, body: null });
    // B's public ingress: B cannot own it, so its Worker reaches the cell through A.
    expect(
      await (await b.fetch(new Request("http://app/", { method: "POST", body: "via B" }))).json(),
    ).toEqual({
      n: 2,
      body: "via B",
    });
    // JS RPC is forwarded too.
    expect(await (b.env.COUNTER as any).getByName("shared").peek()).toBe(2);

    // A shuts down: its lease is released; B takes the cell over and restores it from the log.
    await a.close();
    expect(await (await b.fetch(new Request("http://app/"))).json()).toEqual({ n: 3, body: null });
    expect(
      await leases.get("B")!.holder("Counter/" + (b.env.COUNTER as any).idFromName("shared")),
    ).toBe("B");
  });
});
