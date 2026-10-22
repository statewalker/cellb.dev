import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idFromName, namespaceKey } from "../src/core/id.js";
import {
  CellRouter,
  createWebSocketClass,
  linkOverPort,
  serveHandlerOverPort,
  shardOf,
} from "../src/index.js";

// WebSockets across the sharded topology: router ⇄ shard workers over MessagePorts,
// sockets opened by the router (a page's socket) and by a Worker in another shard.
const SHARDS = 3;
const BINDINGS = { COUNTER: "Counter", ROOM: "Room" };

describe("P07x WebSocket routing: control ports carry socket ports between router and shard workers", () => {
  const dir = mkdtempSync(join(tmpdir(), "cells-wsr-"));
  let bundle = "";
  const threads: Worker[] = [];
  beforeAll(async () => {
    bundle = join(dir, "shard-worker.mjs");
    await build({
      entryPoints: [join(__dirname, "shard-worker.entry.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    });
  });
  afterAll(async () => {
    for (const w of threads) await w.terminate();
  });

  async function start() {
    const router = new CellRouter({ shards: SHARDS, bindings: BINDINGS });
    const workers: Worker[] = [];
    for (let shard = 0; shard < SHARDS; shard++) {
      const w = new Worker(bundle, { workerData: { shard, shards: SHARDS, dir } });
      threads.push(w);
      workers.push(w);
      await new Promise((r) => w.once("message", r));
      const down = new MessageChannel();
      const up = new MessageChannel();
      const ctl = new MessageChannel();
      await serveHandlerOverPort(up.port1 as any, router.internal);
      w.postMessage({ type: "link", down: down.port2, up: up.port2, ctl: ctl.port2 }, [
        down.port2,
        up.port2,
        ctl.port2,
      ] as any);
      await new Promise((r) => w.once("message", r));
      router.attach(
        shard,
        (await linkOverPort(down.port1 as any)).send,
        undefined,
        ctl.port1 as any,
      );
    }
    const WS = createWebSocketClass((url, protocols) => router.connectWebSocket(url, protocols));
    return { router, WS, workers };
  }
  const roomIn = (shard: number, tag: string) => {
    for (let i = 0; ; i++)
      if (
        shardOf(idFromName(namespaceKey("worker", "Room"), `${tag}${i}`).toString(), SHARDS) ===
        shard
      )
        return `${tag}${i}`;
  };
  const next = (ws: any, type: string) =>
    new Promise<any>((r) => ws.addEventListener(type, r, { once: true }));

  it("sockets reach their room whichever shard runs the Worker fetch (local and cross-shard), and broadcast between them", async () => {
    const { WS } = await start();
    const room = roomIn(1, "chat");

    // Ingress is round-robin over shards 0,1,2: first socket enters via shard 0 (crosses to 1),
    // second via shard 1 (local), third via shard 2 (crosses to 1).
    const sockets = [
      new WS(`ws://cells.local/room/${room}`),
      new WS(`ws://cells.local/room/${room}`),
      new WS(`ws://cells.local/room/${room}`),
    ];
    await Promise.all(sockets.map((s) => next(s, "open")));

    const where = next(sockets[0], "message");
    sockets[0].send("where?");
    expect((await where).data).toBe("where:shard1");

    const got = Promise.all(sockets.map((s) => next(s, "message")));
    sockets[2].send("hello room");
    expect((await got).map((e) => e.data)).toEqual(["hello room", "hello room", "hello room"]);
    const closed = next(sockets[1], "close");
    sockets[1].send("bye");
    expect((await closed).code).toBe(4000);
  });

  it("a refused upgrade across shards is an error + close 1006 for the client", async () => {
    const { WS } = await start();
    const ws = new WS("ws://cells.local/counter/x"); // Counter.fetch is not a WebSocket endpoint
    const ev = await next(ws, "close");
    expect([ev.code, ev.wasClean]).toEqual([1006, false]);
  });

  it("a pending socket fails when its shard's owner is lost", async () => {
    const { router, WS, workers } = await start();
    // Stall shard 0's control handling by terminating it right after the request is sent.
    const ws = new WS(`ws://cells.local/room/${roomIn(0, "gone")}`);
    await workers[0].terminate();
    router.detach(0);
    const ev = await next(ws, "close");
    expect(ev.code).toBe(1006);
  });

  it("a Durable Object can be a WebSocket CLIENT of another one, locally and across shards", async () => {
    const { WS } = await start();
    const home = roomIn(0, "home");
    const sameShard = roomIn(0, "near");
    const otherShard = roomIn(2, "far");
    const ws = new WS(`ws://cells.local/room/${home}`);
    await next(ws, "open");
    const replies: string[] = [];
    for (const target of [sameShard, otherShard]) {
      const m = next(ws, "message");
      ws.send(`relay:${target}:ping`);
      replies.push((await m).data);
    }
    expect(replies).toEqual([
      `relayed:${sameShard}:ping:relay.v1`,
      `relayed:${otherShard}:ping:relay.v1`,
    ]);
  });
});
