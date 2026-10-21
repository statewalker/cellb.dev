/// <reference lib="webworker" />
// Runs one celld project (bundled by conformance/browser-bundle.ts) on webrun-cells inside a
// Chromium Dedicated Worker — SQLite on OPFS (sahpool), KV/R2 blobs on an OPFS FilesApi —
// executes its scenario against the in-browser runtime and returns transcript + user logs.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import {
  formatLog,
  normalizeLogs,
  runScenario,
  scenarios,
  type Target,
  withContentLength,
} from "../../conformance/scenarios.js";
import { sahpoolOpener } from "../../src/adapters/wasm-sqlite.js";
import { createWebSocketClass } from "../../src/index.js";
import { browserModuleLoader } from "../../src/project/browser-modules.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import { createProjectRuntime, type WranglerConfig } from "../../src/project/wrangler.js";
import { CellsResponse, WebSocketPair } from "../../src/ws/server.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";

interface Job {
  project: {
    name: string;
    config: WranglerConfig;
    code: string | null;
    assets: [string, string][];
  };
  scenario: string;
  wsServer?: string;
}

scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { project, scenario: name, wsServer } = e.data as Job;
  // User logs, formatted as celld prints them.
  const logs: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const real = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      logs.push(formatLog(args));
      real(...args);
    };
  }
  try {
    const g = globalThis as Record<string, unknown>;
    g.__cellsWorkersModule = workersModule;
    g.__cellsGlobals = { Response: CellsResponse, WebSocketPair };
    const module = project.code
      ? await import(
          /* @vite-ignore */ URL.createObjectURL(
            new Blob([project.code], { type: "text/javascript" }),
          )
        )
      : { default: {} };
    // `sqlite_vec` projects need a SQLite WASM build with sqlite-vec compiled in.
    const vec = project.config.compatibility_flags?.includes("sqlite_vec");
    // The sqlite-vec build rejects Emscripten module options at init time.
    const sqlite3 = vec
      ? await ((await import("sqlite-vec-wasm-demo")).default as any)()
      : await (sqlite3InitModule as any)({ print() {}, printErr() {} });
    const run = `${project.name}-${Date.now().toString(36)}`;
    const openSql = await sahpoolOpener(sqlite3, { name: `cells-${run}`, initialCapacity: 32 });
    const root = await navigator.storage.getDirectory();
    const files = new BrowserFilesApi({
      rootHandle: await root.getDirectoryHandle(`files-${run}`, { create: true }),
    });
    const assetFiles = new Map(
      project.assets.map(
        ([p, b64]) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))] as const,
      ),
    );
    const { runtime, unsupported } = createProjectRuntime(project.config, module, {
      openSql,
      files,
      assetFiles,
      loadModules: browserModuleLoader(WORKERS_MODULE_SHIM),
    });
    const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
    const target: Target = {
      origin: "http://127.0.0.1:18701",
      wsServer,
      fetch: async (req) => withContentLength(req, await runtime.fetch(req)),
      websocket: (url) =>
        new Promise((resolve, reject) => {
          const ws = new WS(url);
          const queue: unknown[] = [];
          const waiters: ((v: unknown) => void)[] = [];
          ws.onmessage = (ev: MessageEvent) =>
            waiters.length ? waiters.shift()!(ev.data) : queue.push(ev.data);
          ws.onerror = () => reject(new Error("websocket error"));
          ws.onopen = () =>
            resolve({
              send: (m: string) => ws.send(m),
              next: () =>
                queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
              close: () => ws.close(),
            });
        }),
    };
    const scenario = scenarios[name];
    logs.length = 0;
    const transcript = await runScenario(target, scenario);
    let normalized: string[] | undefined;
    if (scenario.logs) {
      await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
      normalized = normalizeLogs(logs, scenario);
    }
    reply({ ok: true, transcript, logs: normalized, unsupported });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
