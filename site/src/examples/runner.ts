/// <reference lib="webworker" />
// Runs one example in its Dedicated Worker (started by run-worker.ts): loadProject loads the
// project as scripts/build-examples.ts built it (`cellb build`, at /built/<project>/) and runs it on
// CellB (SQLite WASM on OPFS); then the worker sends the requests of its conformance scenario. The page compares the answers with the ones celld recorded.

import { createWebSocketClass, type WranglerConfig } from "@statewalker/cellb";
import { loadProject } from "@statewalker/cellb/browser";
import {
  formatLog,
  normalizeLogs,
  runScenario,
  scenarios,
  type Target,
  withContentLength,
} from "../../../packages/cellb/conformance/scenarios";
import { REFERENCE_SERVER } from "./reference-server";

export type RunMessage =
  | { type: "request"; label: string }
  | { type: "done"; transcript: unknown[]; logs?: string[]; unsupported: string[] }
  | { type: "error"; error: string };

/** SQLite WASM with sqlite-vec, served as its package ships it (see scripts/build-examples.ts). */
const VEC_MODULE = "/vendor/sqlite-vec/sqlite3.mjs";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: RunMessage) => scope.postMessage(m);

// What each run writes to OPFS (its SQLite pool and files), removed after the run. Runs that
// were cut short (a closed tab) leave theirs, removed here when the next run starts.
const PREFIX = "cellb-example-";
async function removeLeftovers() {
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
    if (name.replace(/^\./, "").startsWith(PREFIX))
      await root.removeEntry(name, { recursive: true }).catch(() => {}); // in use by another tab
}

// Some tests throw on purpose where nothing catches it (wd-worker-loader's isolate
// self-destruct): Worker code's uncaught errors stay in this worker, as they stay in its isolate.
scope.addEventListener("error", (e) => e.preventDefault());
scope.addEventListener("unhandledrejection", (e) => e.preventDefault());

const userLogs: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) {
  const real = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    userLogs.push(formatLog(args));
    real(...args);
  };
}

export async function handle(e: MessageEvent<{ scenario: string; url: string }>) {
  const { scenario: name, url } = e.data;
  const run = `${PREFIX}${Date.now().toString(36)}`;
  try {
    await removeLeftovers();
    // sqlite_vec needs a SQLite WASM build with sqlite-vec compiled in; loadProject's default
    // SQLite WASM has none.
    const config = (await (await fetch(new URL("wrangler.json", url))).json()) as WranglerConfig;
    const sqlite3 = config.compatibility_flags?.includes("sqlite_vec")
      ? await ((await import(/* @vite-ignore */ VEC_MODULE)).default as () => Promise<unknown>)()
      : undefined;
    const host = await loadProject(url, { data: run, sqlite3 });
    const { runtime } = host;
    const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
    const target: Target = {
      origin: "http://127.0.0.1:18701",
      wsServer: REFERENCE_SERVER,
      fetch: async (req) => {
        post({ type: "request", label: `${req.method} ${new URL(req.url).pathname}` });
        return withContentLength(req, await runtime.fetch(req));
      },
      websocket: (url) =>
        new Promise((resolve, reject) => {
          post({ type: "request", label: `WebSocket ${new URL(url).pathname}` });
          const ws = new WS(url);
          const queue: unknown[] = [];
          const waiters: ((v: unknown) => void)[] = [];
          ws.onmessage = (ev: MessageEvent) => {
            const w = waiters.shift();
            if (w) w(ev.data);
            else queue.push(ev.data);
          };
          ws.onerror = () => reject(new Error("WebSocket error"));
          ws.onopen = () =>
            resolve({
              send: (m: string) => ws.send(m),
              next: () =>
                queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
              close: () => ws.close(),
            });
        }),
    };
    const s = scenarios[name];
    userLogs.length = 0;
    const transcript = await runScenario(target, s);
    let logs: string[] | undefined;
    if (s.logs) {
      await new Promise((r) => setTimeout(r, s.settleMs ?? 1500));
      logs = normalizeLogs(userLogs, s);
    }
    await host.close();
    await removeLeftovers();
    post({ type: "done", transcript, logs, unsupported: host.unsupported });
  } catch (err) {
    post({ type: "error", error: String((err as Error)?.stack ?? err) });
  }
}
