/// <reference lib="webworker" />
// One shard: its own opfs-sahpool (pools are exclusive per worker), its own cells.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import {
  CellsResponse,
  createShardHost,
  DurableObject,
  type ShardHost,
  WebSocketPair,
  type WorkerModule,
} from "../../src/index.js";
import { worker as fixture } from "../../test/fixtures.js";

/**
 * Worker module of this shard: the test fixture (Counter, Room) plus the UNMODIFIED
 * Cloudflare-style Lobby worker, built by webrun-modules in the ServiceWorker.
 * This realm's host registry is what the Lobby's ~deps proxies resolve against.
 */
async function loadWorker(): Promise<WorkerModule> {
  (globalThis as any).__webrunHostRegistry = new Map<string, unknown>([
    ["cloudflare:workers", { DurableObject }],
    ["WebSocketPair", WebSocketPair],
    ["Response", CellsResponse],
    ["WebSocket", (globalThis as any).WebSocket],
  ]);
  const lobby = await import(
    /* @vite-ignore */ `${location.origin}/sharded/modules/~/lobby-worker.ts`
  );
  return {
    ...fixture,
    Lobby: lobby.Lobby,
    default: {
      fetch(req, env, ctx) {
        return new URL(req.url).pathname.startsWith("/lobby/")
          ? lobby.default.fetch(req, env, ctx)
          : fixture.default.fetch!(req, env, ctx);
      },
    },
  };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
let host: ShardHost | undefined;

scope.addEventListener("message", async (e) => {
  const m = e.data;
  if (m?.type === "init") {
    const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr: console.error });
    const openSql = await sahpoolOpener(sqlite3, { name: `webrun-cells-shard-${m.shard}` });
    host = createShardHost({
      shard: m.shard,
      shards: m.shards,
      worker: await loadWorker(),
      durableObjects: {
        COUNTER: { className: "Counter" },
        ROOM: { className: "Room" },
        LOBBY: { className: "Lobby" },
      },
      openSql,
    });
    // A lock only this worker holds: released by the browser the moment the worker
    // (or its tab) dies — the router's liveness signal (MessagePorts report nothing).
    const ownerLock = `webrun-cells:owner:${m.shard}:${crypto.randomUUID()}`;
    await new Promise<void>(
      (held) => void navigator.locks.request(ownerLock, () => (held(), new Promise(() => {}))),
    );
    scope.postMessage({ type: "ready", ownerLock });
  } else if (m?.type === "link") {
    await host!.link(m.down, m.up, m.ctl);
    scope.postMessage({ type: "linked" });
  }
});
