// Browser mutation harness (needs Chromium: PW_CHROMIUM or `npx playwright install chromium`).
import { runMutants } from "./mutation-sandbox.mjs";

const mutants = [
  [
    "SW never asks pages to re-attach",
    "browser/sharded/sw.ts",
    "onMissingShard: () => void askForLinks(),",
    "onMissingShard: () => {},",
  ],
  [
    "pages spawn shard workers without the Web Lock",
    "browser/sharded/main.ts",
    "await navigator.locks.request(`webrun-cells:shard:${shard}`, async () => {",
    "await (async (cb) => cb())(async () => {",
  ],
  [
    "cell worker uses in-memory SQLite (no OPFS)",
    "browser/cell-worker.ts",
    'const openSql = await sahpoolOpener(sqlite3, { name: "webrun-cells-e2e", initialCapacity: 16 });',
    'const openSql = (await import("../src/adapters/wasm-sqlite.js")).wasmMemoryOpener(sqlite3);',
  ],
  [
    "SW does not watch the owner lock (polling only)",
    "browser/sharded/sw.ts",
    "watchOwner: (_shard, ownerLock) => navigator.locks.request(ownerLock as string, async () => {}),",
    "",
  ],
];
const cmd = process.env.PW_CHROMIUM
  ? "npx playwright test --reporter=dot"
  : "npm run e2e:npm-chromium -- --reporter=dot";
const survived = runMutants(mutants, cmd);
process.exit(survived ? 1 : 0);
