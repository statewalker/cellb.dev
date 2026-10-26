/// <reference lib="webworker" />
// One loaded Worker in its own realm (a Dedicated Worker), served over its port.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { sahpoolOpener } from "../adapters/wasm-sqlite.js";
import { browserModuleLoader } from "../project/browser-modules.js";
import * as workersModule from "../project/cloudflare-workers.js";
import { workersHostRegistry } from "../project/site.js";
import * as workersGlobals from "../project/workers-globals-module.js";
import { serveIsolate } from "./isolate.js";
import type { PortLike } from "./protocol.js";

(globalThis as Record<string, unknown>).__cellsWorkersModule = workersModule;
workersHostRegistry({
  workersModule,
  ...workersGlobals,
  Response: workersGlobals.CellsResponse,
  WebSocket: workersGlobals.WorkersWebSocket,
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
    return browserModuleLoader()(
      "isolate",
      { mainModule: load.mainModule, modules: load.modules, env: load.env },
      (level, args) => logs(level, args),
    );
  },
  {
    patchConsole: false,
    // Facets of the loaded code: SQLite on OPFS, one sahpool per loaded Worker.
    openSql: async (load: any) => {
      const sqlite3 = await (sqlite3InitModule as any)({ print() {}, printErr() {} });
      return sahpoolOpener(sqlite3, { name: load?.storageName ?? "isolate" });
    },
  },
);
