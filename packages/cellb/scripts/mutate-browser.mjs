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
    "src/transport/cells-http.ts",
    "return upgrade ? withUpgrade(to, upgrade) : to;",
    "return to;",
    "websocket",
  ],
  [
    "OPFS restore does not import the image",
    "src/adapters/wasm-sqlite.ts",
    "(pool as any).importDb(path, image);",
    "",
    "backup",
  ],
];
const cmd = process.env.PW_CHROMIUM
  ? "npx playwright test --reporter=dot"
  : "npm run e2e:npm-chromium -- --reporter=dot";
const survived = runMutants(mutants, cmd);
process.exit(survived ? 1 : 0);
