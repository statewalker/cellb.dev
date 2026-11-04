/// <reference lib="webworker" />
// Runs celld's counter example (index.js, unchanged) with this folder's wrangler.jsonc on cellb,
// in a Dedicated Worker. Each Durable Object is a SQLite WASM database in this origin's OPFS.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { parseJsonc, type WranglerConfig } from "@statewalker/cellb";
import { browserProjectRuntime } from "@statewalker/cellb/browser";
import code from "../../../../packages/cellb/conformance/celld-examples/counter/index.js?raw";
import wrangler from "./wrangler.jsonc?raw";

// Messages with the page (LiveDemo.astro): it sends paths, this worker answers with responses.
type Job = { id: number; path: string };
export type DemoEvent =
  | { type: "waiting" | "starting" }
  | { type: "ready"; startMs: number }
  | { type: "failed"; error: string }
  | { type: "reply"; id: number; status: number; body: string; ms: number };
const post = (e: DemoEvent) => postMessage(e);
const queued: Job[] = [];
let handle = (job: Job) => void queued.push(job); // until the runtime is ready
addEventListener("message", (e: MessageEvent<Job>) => handle(e.data));
post({ type: "waiting" });

// An OPFS pool belongs to one worker, so one tab runs the cells. Another tab waits for the lock
// and takes over, from the same files, when this one closes.
navigator.locks
  .request("cellb.dev:demo:counter", async () => {
    post({ type: "starting" });
    const t0 = performance.now();
    const sqlite3 = await sqlite3InitModule();
    const { runtime } = await browserProjectRuntime({
      config: parseJsonc(wrangler) as WranglerConfig,
      code: { bundle: code },
      sqlite3,
      pool: "cellb-demo-counter",
      filesDir: "cellb-demo-counter-files",
    });
    post({ type: "ready", startMs: performance.now() - t0 });

    // Each path goes to the project's fetch handler, as an HTTP request would on celld.
    const serve = async ({ id, path }: Job) => {
      const t = performance.now();
      const res = await runtime.fetch(new Request(`https://counter.demo${path}`));
      const body = await res.text();
      post({ type: "reply", id, status: res.status, body, ms: performance.now() - t });
    };
    for (const job of queued.splice(0)) void serve(job);
    handle = (job) => void serve(job);

    await new Promise(() => {}); // hold the lock while the tab is open
  })
  .catch((err) => post({ type: "failed", error: String(err?.message ?? err) }));
