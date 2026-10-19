import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CellRouter,
  createCellRuntime,
  createWebSocketClass,
  linkOverPort,
  serveHandlerOverPort,
} from "../src/index.js";
import { worker } from "./fixtures.js";
import { cases, knownNativeDeviations, type WsEnv } from "./ws-conformance.js";
import { startReferenceServer } from "./ws-reference-server.js";

// The same WHATWG WebSocket conformance cases against three implementations.
// Native = Node 22's built-in WebSocket (undici) talking to a real `ws` server.
const impls: Record<string, () => Promise<{ env: WsEnv; stop(): Promise<void> }>> = {
  async "native WebSocket ⇄ ws server"() {
    const srv = await startReferenceServer();
    const base = `ws://127.0.0.1:${srv.port}`;
    return {
      env: {
        WS: globalThis.WebSocket,
        room: (n) => `${base}/room/${n}`,
        refused: `${base}/nope`,
        label: "native",
      },
      stop: () => srv.close(),
    };
  },
  async "webrun-cells, in-process runtime"() {
    const rt = createCellRuntime({
      worker,
      durableObjects: { COUNTER: { className: "Counter" }, ROOM: { className: "Room" } },
      openSql: nodeSqliteOpener(),
    });
    const WS = createWebSocketClass((url, p) => rt.connectWebSocket(url, p));
    return {
      env: {
        WS,
        room: (n) => `ws://cells.local/room/${n}`,
        refused: "ws://cells.local/nope/x",
        label: "cells",
      },
      stop: () => rt.close(),
    };
  },
  async "webrun-cells, router + 3 worker-thread shards (local and cross-shard)"() {
    const SHARDS = 3;
    const dir = mkdtempSync(join(tmpdir(), "cells-wsc-"));
    const bundle = join(dir, "shard-worker.mjs");
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
    const router = new CellRouter({
      shards: SHARDS,
      bindings: { COUNTER: "Counter", ROOM: "Room" },
    });
    const threads: Worker[] = [];
    for (let shard = 0; shard < SHARDS; shard++) {
      const w = new Worker(bundle, { workerData: { shard, shards: SHARDS, dir } });
      threads.push(w);
      await new Promise((r) => w.once("message", r));
      const [down, up, ctl] = [new MessageChannel(), new MessageChannel(), new MessageChannel()];
      await serveHandlerOverPort(up.port1 as never, router.internal);
      w.postMessage({ type: "link", down: down.port2, up: up.port2, ctl: ctl.port2 }, [
        down.port2,
        up.port2,
        ctl.port2,
      ] as never);
      await new Promise((r) => w.once("message", r));
      router.attach(
        shard,
        (await linkOverPort(down.port1 as never)).send,
        undefined,
        ctl.port1 as never,
      );
    }
    const WS = createWebSocketClass((url, p) => router.connectWebSocket(url, p));
    return {
      env: {
        WS,
        room: (n) => `ws://cells.local/room/${n}`,
        refused: "ws://cells.local/nope/x",
        label: "shards",
      },
      stop: async () => {
        for (const w of threads) await w.terminate();
      },
    };
  },
};

for (const [implName, start] of Object.entries(impls)) {
  describe(`P07y WebSocket conformance — ${implName}`, () => {
    let ctx: Awaited<ReturnType<typeof start>>;
    beforeAll(async () => {
      ctx = await start();
    }, 30_000);
    afterAll(() => ctx?.stop());
    const skip = implName.startsWith("native") ? knownNativeDeviations["node-undici"] : {};
    for (const [name, run] of Object.entries(cases)) {
      if (skip[name]) it.skip(`${name} — native deviation: ${skip[name]}`, () => {});
      else it(name, () => run(ctx.env), 20_000);
    }
  });
}

// The deviations above are facts about Node's WebSocket, not assumptions: keep them proven.
describe("P07y Node's native WebSocket deviations (documented)", () => {
  it("refused handshake: 'error' only, no 'close'; close() while connecting: no 'close'", async () => {
    const net = await import("node:net");
    const srv = net.createServer((c) =>
      c.once("data", () => c.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")),
    );
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `ws://127.0.0.1:${(srv.address() as { port: number }).port}/x`;
    const logs = [new WebSocket(url), new WebSocket(url)].map((ws, i) => {
      const log: string[] = [];
      ws.onerror = () => log.push("error");
      ws.onclose = () => log.push("close");
      if (i === 1) ws.close();
      return log;
    });
    await new Promise((r) => setTimeout(r, 1500));
    srv.close();
    expect(logs[0]).toContain("error");
    expect(logs[0]).not.toContain("close");
    expect(logs[1]).not.toContain("close");
  });
});
