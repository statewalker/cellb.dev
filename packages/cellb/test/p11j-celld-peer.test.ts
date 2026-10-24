import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { celldBucket } from "../src/bucket/celld-cells.js";
import { sqliteObjectStore } from "../src/bucket/sqlite-object-store.js";
import { celldPeers, startCelldPeerServer } from "../src/peer/celld-peer.js";
import { loadNodeProject } from "../src/project/node-project.js";
import { createWebSocketClass } from "../src/ws/client.js";

// A mixed fleet: a webrun-cells node in Node speaks celld's peer protocol, so when it owns a
// cell, celld ROUTES that cell's requests (fetch and JS RPC) to it through /peer/tunnel instead
// of refusing — one fleet, two runtimes.
const CELLD = process.env.CELLD_BIN;
const examples = join(__dirname, "../conformance/celld-examples");

async function celldDev(dir: string, port: number) {
  const p = spawn(CELLD!, ["dev", ".", "--port", String(port), "--logs"], {
    cwd: dir,
    env: { ...process.env, PATH: `${process.env.ESBUILD_DIR ?? ""}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes("ready"); i++)
    await new Promise((r) => setTimeout(r, 200));
  return { p, base: `http://127.0.0.1:${port}`, log: () => log };
}
const stop = (p: ChildProcess) =>
  new Promise<void>((r) => (p.once("exit", () => r()), p.kill("SIGTERM")));

async function webrunPeer(dir: string) {
  const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
  const node = "webrun-peer";
  const bucket = celldBucket(store, { node, leaseTtlMs: 3_000 });
  const { runtime } = await loadNodeProject(dir, {
    openSql: nodeSqliteOpener(),
    files: new MemFilesApi(),
    ownership: bucket.ownership,
    durability: bucket.durability,
    backup: bucket.durability,
    bucketStore: store,
  } as never);
  const peer = await startCelldPeerServer({ runtime, store, node });
  await bucket.advertise(peer.addr);
  return {
    get: async (path: string) => (await runtime.fetch(new Request(`http://w${path}`))).text(),
    fetch: (path: string, init?: RequestInit) =>
      runtime.fetch(new Request(`http://w${path}`, init)),
    close: async () => {
      await peer.close();
      await runtime.close();
      await bucket.close();
      store.close();
    },
  };
}

describe.skipIf(!CELLD)("P11j webrun-cells as a celld peer (mixed fleet)", () => {
  it("celld routes requests for a cell webrun-cells owns to it (fetch)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-fetch-")), "counter");
    cpSync(join(examples, "counter"), dir, { recursive: true });
    const c0 = await celldDev(dir, 18_870); // creates the bucket and the fleet secret
    await stop(c0.p);
    const w = await webrunPeer(dir);
    const celld = await celldDev(dir, 18_871);
    try {
      expect(JSON.parse(await w.get("/increment?name=a")).n).toBe(1); // webrun-cells owns the cell
      const viaCelld = await (await fetch(`${celld.base}/increment?name=a`)).text();
      expect(
        viaCelld,
        celld
          .log()
          .split("\n")
          .filter((l) => /tunnel|peer|route/i.test(l))
          .slice(-8)
          .join("\n"),
      ).toMatch(/"n":2/);
      expect(JSON.parse(await w.get("/increment?name=a")).n).toBe(3);
    } finally {
      await stop(celld.p);
      await w.close();
    }
  }, 120_000);

  it("celld routes JS RPC to a cell webrun-cells owns", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-rpc-")), "rpc");
    cpSync(join(examples, "rpc"), dir, { recursive: true });
    const c0 = await celldDev(dir, 18_872);
    await stop(c0.p);
    const w = await webrunPeer(dir);
    const celld = await celldDev(dir, 18_873);
    try {
      const post = async (f: (u: string, init: RequestInit) => Promise<Response>) =>
        (await f("/", { method: "POST" })).text();
      expect(await post((u, init) => Promise.resolve(w.fetch(u, init)))).toBe('{"count":1}'); // webrun-cells owns it
      // celld's Worker calls counter.increment(1): the RPC crosses the tunnel to webrun-cells
      const viaCelld = await post((u, init) => fetch(celld.base + u, init));
      expect(
        viaCelld,
        celld
          .log()
          .split("\n")
          .filter((l) => /tunnel|peer|rpc|route/i.test(l))
          .slice(-8)
          .join("\n"),
      ).toBe('{"count":2}');
      expect(await w.get("/")).toBe('{"count":2}');
    } finally {
      await stop(celld.p);
      await w.close();
    }
  }, 120_000);

  it("webrun-cells routes requests and RPC for a cell celld owns to celld (the other direction)", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-out-")), "rpc");
    cpSync(join(examples, "rpc"), dir, { recursive: true });
    const celld = await celldDev(dir, 18_874);
    try {
      expect(await (await fetch(`${celld.base}/`, { method: "POST" })).text()).toBe('{"count":1}'); // celld owns it
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const node = "webrun-caller";
      const bucket = celldBucket(store, { node, leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
        bucketStore: store,
        peers: celldPeers({ store, node }),
      } as never);
      try {
        // webrun-cells' Worker calls counter.increment(1): the cell is celld's, so the RPC goes there
        const r = await (await runtime.fetch(new Request("http://w/", { method: "POST" }))).text();
        expect(r).toBe('{"count":2}');
        expect(await (await fetch(`${celld.base}/`)).text()).toBe('{"count":2}');
      } finally {
        await runtime.close();
        await bucket.close();
        store.close();
      }
    } finally {
      await stop(celld.p);
    }
  }, 120_000);

  it("webrun-cells routes a stub.fetch() for a cell celld owns to celld", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-out-fetch-")), "counter");
    cpSync(join(examples, "counter"), dir, { recursive: true });
    const celld = await celldDev(dir, 18_876);
    try {
      expect(JSON.parse(await (await fetch(`${celld.base}/increment?name=a`)).text()).n).toBe(1);
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const node = "webrun-caller-2";
      const bucket = celldBucket(store, { node, leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
        bucketStore: store,
        peers: celldPeers({ store, node }),
      } as never);
      try {
        const r = JSON.parse(
          await (await runtime.fetch(new Request("http://w/increment?name=a"))).text(),
        );
        expect(r.n).toBe(2);
        expect(JSON.parse(await (await fetch(`${celld.base}/increment?name=a`)).text()).n).toBe(3);
      } finally {
        await runtime.close();
        await bucket.close();
        store.close();
      }
    } finally {
      await stop(celld.p);
    }
  }, 120_000);

  it("a WebSocket opened at celld to a cell webrun-cells owns crosses the tunnel", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-ws-")), "wsecho");
    cpSync(join(examples, "wsecho"), dir, { recursive: true });
    const c0 = await celldDev(dir, 18_878);
    await stop(c0.p);
    const w = await webrunPeer(dir);
    const celld = await celldDev(dir, 18_879);
    try {
      // webrun-cells takes the cell (one plain request makes it the owner)
      expect(await w.get("/")).toBe("websocket upgrade required");
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`ws://127.0.0.1:18879/`);
      const got: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => (ws.send("hello"), ws.send("again")));
        ws.on("message", (d) => {
          got.push(d.toString());
          if (got.length === 2) resolve();
        });
        ws.on("error", reject);
        setTimeout(
          () =>
            reject(
              new Error(
                `timeout; got ${got}; ${celld
                  .log()
                  .split("\n")
                  .filter((l) => /tunnel|peer|websocket/i.test(l))
                  .slice(-6)
                  .join("\n")}`,
              ),
            ),
          15_000,
        );
      });
      ws.close();
      expect(got.map((g) => JSON.parse(g))).toEqual([
        { echo: "hello", count: 1 },
        { echo: "again", count: 2 },
      ]);
    } finally {
      await stop(celld.p);
      await w.close();
    }
  }, 120_000);

  it("a WebSocket opened at webrun-cells to a cell celld owns crosses the tunnel", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "peer-ws-out-")), "wsecho");
    cpSync(join(examples, "wsecho"), dir, { recursive: true });
    const celld = await celldDev(dir, 18_884);
    try {
      // celld takes the cell: one socket, one message
      const { WebSocket: Ws } = await import("ws");
      const first = new Ws("ws://127.0.0.1:18884/");
      await new Promise<void>((r) =>
        first.on("open", () => first.send("from celld")).on("message", () => r()),
      );
      first.close();
      const store = sqliteObjectStore(join(dir, ".celld/dev/objects.sqlite3"));
      const node = "webrun-ws-caller";
      const bucket = celldBucket(store, { node, leaseTtlMs: 3_000 });
      const { runtime } = await loadNodeProject(dir, {
        openSql: nodeSqliteOpener(),
        files: new MemFilesApi(),
        ownership: bucket.ownership,
        durability: bucket.durability,
        backup: bucket.durability,
        bucketStore: store,
        peers: celldPeers({ store, node }),
      } as never);
      try {
        const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
        const ws = new WS("ws://w/") as WebSocket;
        const got: string[] = [];
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => (ws.send("hello"), ws.send("again"));
          ws.onmessage = (e) => {
            got.push(String(e.data));
            if (got.length === 2) resolve();
          };
          ws.onerror = () => reject(new Error("websocket error"));
          setTimeout(() => reject(new Error(`timeout; got ${got}`)), 15_000);
        });
        ws.close();
        // the count lives in celld's cell: it continues from celld's own message
        expect(got.map((g) => JSON.parse(g))).toEqual([
          { echo: "hello", count: 2 },
          { echo: "again", count: 3 },
        ]);
      } finally {
        await runtime.close();
        await bucket.close();
        store.close();
      }
    } finally {
      await stop(celld.p);
    }
  }, 120_000);
});
