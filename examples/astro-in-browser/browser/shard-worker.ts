/// <reference lib="webworker" />
// A shard of the built app: its Worker, run by cellb.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

// The shard's errors, relayed to the host page's console.
const real = console.error.bind(console);
console.error = (...args: unknown[]) => {
  postMessage({
    shardLog: args
      .map((a) => (a instanceof Error ? a.stack : String(a)))
      .join(" ")
      .slice(0, 2000),
  });
  real(...args);
};
self.addEventListener("error", (e) => postMessage({ shardLog: `uncaught: ${e.message}` }));
self.addEventListener("unhandledrejection", (e) =>
  postMessage({ shardLog: `unhandled: ${(e.reason as Error)?.stack ?? e.reason}` }),
);
// A heartbeat: when it stops, this worker's thread is busy (evaluating the bundle, say).
const t0 = performance.now();
let beats = 0;
const beat = setInterval(() => {
  beats++;
  if (beats % 5 === 0)
    postMessage({ shardLog: `alive ${Math.round((performance.now() - t0) / 1000)}s` });
  if (beats > 120) clearInterval(beat);
}, 1000);
const realCreate = URL.createObjectURL;
URL.createObjectURL = (b: Blob | MediaSource) => {
  postMessage({ shardLog: `importing a module of ${(b as Blob).size ?? "?"} bytes` });
  return realCreate(b);
};
serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });

// Errors of the built Worker (its module evaluation included), for the host's console.
for (const t of ["error", "unhandledrejection"] as const)
  self.addEventListener(t, (e) =>
    console.error(
      `[shard] ${t}:`,
      (e as ErrorEvent).error?.stack ??
        (e as PromiseRejectionEvent).reason?.stack ??
        (e as ErrorEvent).message,
    ),
  );
