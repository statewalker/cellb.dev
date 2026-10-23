// Shared by the project workers: builds a webrun-cells runtime for a project in a
// Dedicated Worker (SQLite on OPFS, OPFS FilesApi), runs its scenario, captures user logs.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  formatLog,
  normalizeLogs,
  runScenario,
  scenarios,
  type Target,
  withContentLength,
} from "../../conformance/scenarios.js";
import type { ModuleLoader } from "../../src/bindings/worker-loader.js";
import type { WorkerModule } from "../../src/core/runtime.js";
import { createWebSocketClass } from "../../src/index.js";
import { browserProjectRuntime } from "../../src/project/browser-host.js";
import type { WranglerConfig } from "../../src/project/wrangler.js";

/** Captures the realm's console as celld prints user logs (call before running user code). */
export function captureLogs(): string[] {
  const logs: string[] = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const real = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      logs.push(formatLog(args));
      real(...args);
    };
  }
  return logs;
}

export async function runProject(job: {
  name: string;
  scenario: string;
  config: WranglerConfig;
  module: Record<string, unknown>;
  assets: [string, string][];
  wsServer?: string;
  loadModules: ModuleLoader;
  isolatedModules?: ModuleLoader;
  logs: string[];
  /**
   * A celld fleet bucket (browser-host.ts): on S3 shared with celld nodes (`endpoint` …), or in
   * this origin's OPFS (`opfs`: a directory name).
   */
  bucket?:
    | {
        endpoint: string;
        signAs: string;
        bucket: string;
        prefix: string;
        accessKeyId: string;
        secretAccessKey: string;
        node: string;
      }
    | { opfs: string; node: string };
  /** With `bucket`: fetch these paths (retrying while another node still owns the cell). */
  paths?: string[];
}) {
  const vec = job.config.compatibility_flags?.includes("sqlite_vec");
  // sqlite_vec needs a SQLite WASM build with sqlite-vec compiled in (no Emscripten options).
  const sqlite3 = vec
    ? await ((await import("sqlite-vec-wasm-demo")).default as any)()
    : await (sqlite3InitModule as any)({ print() {}, printErr() {} });
  const run = `${job.name}-${Date.now().toString(36)}`;
  const assetFiles = new Map(
    job.assets.map(([p, b64]) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))] as const),
  );
  const b = job.bucket;
  const host = await browserProjectRuntime({
    config: job.config,
    module: job.module,
    sqlite3,
    pool: `cells-${run}`,
    filesDir: `files-${run}`,
    assetFiles,
    loadModules: job.loadModules,
    isolatedModules: job.isolatedModules,
    bucket: !b
      ? undefined
      : "opfs" in b
        ? { opfs: b.opfs, node: b.node, leaseTtlMs: 3_000 }
        : {
            s3: {
              endpoint: b.endpoint,
              signAs: b.signAs,
              bucket: b.bucket,
              prefix: b.prefix,
              accessKeyId: b.accessKeyId,
              secretAccessKey: b.secretAccessKey,
            },
            node: b.node,
            leaseTtlMs: 3_000,
          },
  });
  const { runtime, unsupported } = host;
  const shared = host.bucket;
  if (shared && job.paths) {
    const answers: string[] = [];
    for (const path of job.paths) {
      let text = "";
      for (let i = 0; i < 60; i++) {
        text = await (await runtime.fetch(new Request(`http://browser${path}`))).text();
        if (!text.includes("owned by another")) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      answers.push(text);
    }
    await host.close();
    return { answers };
  }
  const WS = createWebSocketClass((url, p) => runtime.connectWebSocket(url, p));
  const target: Target = {
    origin: "http://127.0.0.1:18701",
    wsServer: job.wsServer,
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
  const scenario = scenarios[job.scenario];
  job.logs.length = 0;
  const transcript = await runScenario(target, scenario);
  let logs: string[] | undefined;
  if (scenario.logs) {
    await new Promise((r) => setTimeout(r, scenario.settleMs ?? 1500));
    logs = normalizeLogs(job.logs, scenario);
  }
  return { transcript, logs, unsupported };
}
