/// <reference lib="webworker" />
// One loaded Worker in its own realm (a Dedicated Worker), served over its port.

import { cellsCaches } from "../../src/bindings/cache.js";
import { serveIsolate } from "../../src/isolate/isolate.js";
import type { PortLike } from "../../src/isolate/protocol.js";
import { browserModuleLoader } from "../../src/project/browser-modules.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import { workersHostRegistry } from "../../src/project/site.js";
import {
  CellsResponse,
  HTMLRewriter,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../../src/ws/server.js";

const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";

(globalThis as Record<string, unknown>).__cellsWorkersModule = workersModule;
workersHostRegistry({
  workersModule,
  Response: CellsResponse,
  WebSocketPair,
  caches: cellsCaches,
  HTMLRewriter,
  WebSocketRequestResponsePair,
});

// The global console is left alone (the dev server's client logs here too): loaded modules
// get a console of their own that reports to the host.
serveIsolate(
  self as unknown as PortLike,
  async (load: any, logs) => {
    const own = Object.assign(Object.create(console), {
      log: (...a: unknown[]) => logs("log", a),
      info: (...a: unknown[]) => logs("info", a),
      warn: (...a: unknown[]) => logs("warn", a),
      error: (...a: unknown[]) => logs("error", a),
      debug: (...a: unknown[]) => logs("debug", a),
    });
    if (load.url) {
      // The site's per-id module server binds `console` to __cellsLoadedConsoles[id].
      const g = globalThis as Record<string, any>;
      g.__cellsLoadedConsoles ??= {};
      g.__cellsLoadedConsoles[load.consoleId] = own;
      return (await import(/* @vite-ignore */ load.url)) as Record<string, unknown>;
    }
    return browserModuleLoader(WORKERS_MODULE_SHIM)(
      "isolate",
      { mainModule: load.mainModule, modules: load.modules },
      (level, args) => logs(level, args),
    );
  },
  { patchConsole: false },
);
