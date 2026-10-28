/// <reference lib="webworker" />
// One shard of the Flue app spread over several workers (startProjectShards in the page). It
// also answers `{ type: "problems" }` with what the app logged as warnings and errors.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";

const problems: string[] = [];
for (const level of ["warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    problems.push(
      `${level}: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")}`,
    );
    real(...args);
  };
}
self.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as { type?: string })?.type === "problems") e.ports[0].postMessage(problems);
});

serveProjectShard({ sqlite3: () => (sqlite3InitModule as any)({ print() {}, printErr() {} }) });
