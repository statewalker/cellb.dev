/// <reference lib="webworker" />
// A shard of the EmDash project: the app, its D1 database, KV sessions and R2 media, in SQLite
// WASM on OPFS. It answers `{ type: "problems" }` with what the app logged as errors.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

const problems: string[] = [];
const real = console.error.bind(console);
console.error = (...args: unknown[]) => {
  problems.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
  real(...args);
};
self.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as { type?: string })?.type === "problems") e.ports[0].postMessage(problems);
});

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
