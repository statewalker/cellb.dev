/// <reference lib="webworker" />
// The homepage demo's worker: celld's own `counter` example (conformance/celld-examples/counter,
// as celld ships it), run unchanged on cellb in this Dedicated Worker. Its Durable Objects live in
// SQLite WASM on this origin's OPFS, so their counts survive a reload.
//
// An OPFS pool belongs to one worker at a time, so one tab runs the cells: the worker waits for a
// Web Lock first. Another tab waits for that lock and takes over, from the same files, when the
// tab that holds it closes.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { WranglerConfig } from "@statewalker/cellb";
import { browserProjectRuntime } from "@statewalker/cellb/browser";
import code from "../../../packages/cellb/conformance/celld-examples/counter/index.js?raw";
import wrangler from "../../../packages/cellb/conformance/celld-examples/counter/wrangler.jsonc?raw";

export type DemoEvent =
  | { type: "waiting" }
  | { type: "starting" }
  | { type: "ready"; startMs: number }
  | { type: "failed"; error: string }
  | { type: "reply"; id: number; status: number; body: string; ms: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (e: DemoEvent) => scope.postMessage(e);

type Runtime = Awaited<ReturnType<typeof browserProjectRuntime>>["runtime"];
let runtime: Runtime | undefined;
const queued: { id: number; path: string }[] = [];

scope.onmessage = (e: MessageEvent<{ id: number; path: string }>) => {
  if (runtime) void serve(runtime, e.data);
  else queued.push(e.data);
};

async function serve(rt: Runtime, { id, path }: { id: number; path: string }) {
  const t0 = performance.now();
  try {
    const res = await rt.fetch(new Request(`https://counter.demo${path}`));
    const body = await res.text();
    post({ type: "reply", id, status: res.status, body, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: "reply", id, status: 0, body: String(err), ms: performance.now() - t0 });
  }
}

post({ type: "waiting" });
navigator.locks.request("cellb.dev:demo:celld-counter", async () => {
  post({ type: "starting" });
  const t0 = performance.now();
  try {
    const sqlite3 = await (sqlite3InitModule as (o: object) => Promise<unknown>)({
      print() {},
      printErr() {},
    });
    const host = await browserProjectRuntime({
      // wrangler.jsonc as celld reads it (this one has no comments).
      config: JSON.parse(wrangler) as WranglerConfig,
      code: { bundle: code },
      sqlite3,
      pool: "cellb-demo-celld-counter",
      filesDir: "cellb-demo-celld-counter-files",
    });
    runtime = host.runtime;
    post({ type: "ready", startMs: performance.now() - t0 });
    for (const job of queued.splice(0)) void serve(runtime, job);
  } catch (err) {
    post({ type: "failed", error: String((err as Error)?.message ?? err) });
    return;
  }
  // Hold the lock, and with it the pool, for as long as this tab is open.
  await new Promise(() => {});
});
