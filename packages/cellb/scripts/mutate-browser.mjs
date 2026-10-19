// Browser mutation harness (needs Chromium: PW_CHROMIUM or `npx playwright install chromium`).
import { runMutants } from "./mutation-sandbox.mjs";

const mutants = [
  [
    "SW never asks pages to re-attach",
    "browser/sharded/sw.ts",
    "onMissingShard: () => void askForLinks(),",
    "onMissingShard: () => {},",
    "sharded",
  ],
  [
    "pages spawn shard workers without the Web Lock",
    "browser/sharded/main.ts",
    "await navigator.locks.request(`webrun-cells:shard:${shard}`, async () => {",
    "await (async (cb) => cb())(async () => {",
    "sharded",
  ],
  [
    "cell worker uses in-memory SQLite (no OPFS)",
    "browser/cell-worker.ts",
    'const openSql = await sahpoolOpener(sqlite3, { name: "webrun-cells-e2e", initialCapacity: 16 });',
    'const openSql = (await import("../src/adapters/wasm-sqlite.js")).wasmMemoryOpener(sqlite3);',
    "cells",
  ],
  [
    "SW does not watch the owner lock (polling only)",
    "browser/sharded/sw.ts",
    "watchOwner: (_shard, ownerLock) => navigator.locks.request(ownerLock as string, async () => {}),",
    "",
    "sharded",
  ],
  [
    "browser drops Upgrade: not re-attached on rebuilt requests",
    "src/ws/upgrade.ts",
    '  const upgrade = from.get("Upgrade");\n  if (!upgrade) return to;',
    '  const upgrade = from.get("Upgrade");\n  return to;',
    "websocket",
  ],
  [
    "OPFS restore does not import the image",
    "src/adapters/wasm-sqlite.ts",
    "(pool as any).importDb(path, image);",
    "",
    "backup",
  ],
  [
    "browser drops Sec-WebSocket-Protocol: not re-attached by connectWebSocket",
    "src/core/runtime.ts",
    'protocols.length ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : undefined',
    "undefined",
    "ws-conformance",
  ],
  [
    "server never notices dead clients (no server heartbeat watch)",
    "src/ws/server.ts",
    "if (Date.now() - this.#lastPing > 3 * hb) this.#gone();",
    "",
    "websocket.spec",
  ],
  // Node keeps Sec-* headers on rebuilt Requests, so only a browser can catch this one.
  [
    "ws: offered subprotocol dropped across shard links",
    "src/router/shard-host.ts",
    "if (offered) headers.set(H.wsProtocol, offered);",
    "",
    "websocket.spec",
  ],
];
// The Playwright config finds a Chrome by itself (PW_CHROMIUM, Playwright's own, or the
// one packaged in node_modules by @sparticuz/chromium).
const cmd = "npx playwright test --reporter=dot";
const survived = runMutants(mutants, cmd);
process.exit(survived ? 1 : 0);
