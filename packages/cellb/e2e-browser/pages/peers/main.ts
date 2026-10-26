// Two nodes in one page, as test/p10c-peer-routing.test.ts runs them on Node: a POST on the node
// that does not own the cell is retried at the owner (runtime.ts) over a link that serves the
// owner's cellsHttpHandler under another scheme, so the owner restores it (cells-http.ts).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  type CellRuntime,
  cellsHttpHandler,
  createCellRuntime,
  DurableObject,
  filesApiChangeLog,
  wasmMemoryOpener,
} from "../../../src/index.js";
import { MemoryLeases } from "../../../test/memory-lease.js";

class Counter extends DurableObject {
  async fetch(req: Request) {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n, body: req.method === "POST" ? await req.text() : null });
  }
}

(window as any).__peers = async () => {
  const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
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
      openSql: wasmMemoryOpener(sqlite3),
      storage: { ...log, ownership: leases.for(name) },
      peers: {
        ownerOf: (cellKey) => Promise.resolve(leases.holder(cellKey)),
        // The wire: plain http, the body as bytes (as an HTTP server would hand it over).
        link: (owner) => async (req) =>
          cellsHttpHandler(nodes.get(owner)!)(
            new Request(`http://link${new URL(req.url).pathname}`, {
              method: req.method,
              headers: req.headers,
              body: req.method === "GET" ? null : await req.arrayBuffer(),
            }),
          ),
      },
    });
    nodes.set(name, rt);
    return rt;
  };
  const a = node("A");
  const b = node("B");
  const first = await (await a.fetch(new Request("https://app/"))).json(); // A takes the cell
  const viaB = await (
    await b.fetch(new Request("https://app/", { method: "POST", body: "via B" }))
  ).json();
  await Promise.all([a.close(), b.close()]);
  return { first, viaB };
};
document.body.dataset.ready = "true";
