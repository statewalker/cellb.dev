import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  CellRouter,
  createCellRuntime,
  createWebSocketClass,
  linkOverPort,
  serveHandlerOverPort,
} from "../src/index.js";
import { worker } from "./fixtures.js";
import { cases, type WsEnv } from "./ws-conformance.js";
import { startReferenceServer } from "./ws-reference-server.js";

// Node's native WebSocket (undici) deviates from WHATWG on connection failures, differently
// per Node version: 22 fires 'error' and never 'close'; 24.8 closes with 1002 instead of
// 1006; 24.21 gets the refused handshake right, but close() while connecting dispatches
// 'error' and 'close' synchronously inside close() and leaves readyState at CLOSING. So the
// deviations are probed on the running Node, not assumed: a native case is skipped only
// when its deviation is observed here.
async function probeNativeDeviations(): Promise<Record<string, string>> {
  const net = await import("node:net");
  const srv = net.createServer((c) =>
    c.once("data", () => c.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")),
  );
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(srv.address() as { port: number }).port}/x`;
  const sockets = [new WebSocket(url), new WebSocket(url)];
  const [refused, closing] = sockets.map((ws, i) => {
    const log: string[] = [];
    ws.onopen = () => log.push("open");
    ws.onerror = () => log.push("error");
    ws.onclose = (e) => log.push(`close:${e.code}`);
    if (i === 1) {
      ws.close();
      log.push(`close() returned, readyState ${ws.readyState}`);
    }
    return log;
  });
  await new Promise((r) => setTimeout(r, 1500));
  srv.close();
  closing.push(`finally readyState ${sockets[1].readyState}`);
  const found = (log: string[]) => `Node ${process.version} logs [${log.join(", ")}]`;
  const deviations: Record<string, string> = {};
  if (refused.join() !== "error,close:1006")
    deviations["refused upgrade: error then close 1006, never open"] = found(refused);
  // What the case asserts: CLOSING right after close(), then (asynchronously) a 'close'
  // event and no 'open', ending CLOSED.
  if (
    closing[0] !== "close() returned, readyState 2" ||
    !closing.some((e) => e.startsWith("close:")) ||
    closing.includes("open") ||
    closing.at(-1) !== "finally readyState 3"
  )
    deviations["close() while CONNECTING: no open, close event, socket CLOSED"] = found(closing);
  return deviations;
}
const nativeDeviations = await probeNativeDeviations();

// The same WHATWG WebSocket conformance cases against three implementations.
// Native = Node's built-in WebSocket (undici) talking to a real `ws` server.
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
    const skip = implName.startsWith("native") ? nativeDeviations : {};
    for (const [name, run] of Object.entries(cases)) {
      if (skip[name]) it.skip(`${name} — native deviation: ${skip[name]}`, () => {});
      else it(name, () => run(ctx.env), 20_000);
    }
  });
}
