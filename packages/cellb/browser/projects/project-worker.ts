/// <reference lib="webworker" />
// Runs one project bundled on the Node side (conformance/browser-bundle.ts); the bundle and
// Worker-Loader code are Blob-URL modules.

import { cellsCaches } from "../../src/bindings/cache.js";
import { browserModuleLoader } from "../../src/project/browser-modules.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import type { WranglerConfig } from "../../src/project/wrangler.js";
import { CellsResponse, HTMLRewriter, WebSocketPair } from "../../src/ws/server.js";
import { captureLogs, runProject } from "./run-project.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";

scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { project, scenario, wsServer } = e.data as {
    project: {
      name: string;
      config: WranglerConfig;
      code: string | null;
      assets: [string, string][];
    };
    scenario: string;
    wsServer?: string;
  };
  const logs = captureLogs();
  try {
    const g = globalThis as Record<string, unknown>;
    g.__cellsWorkersModule = workersModule;
    g.__cellsGlobals = {
      Response: CellsResponse,
      WebSocketPair,
      caches: cellsCaches,
      HTMLRewriter,
    };
    const module = project.code
      ? await import(
          /* @vite-ignore */ URL.createObjectURL(
            new Blob([project.code], { type: "text/javascript" }),
          )
        )
      : { default: {} };
    const r = await runProject({
      name: project.name,
      scenario,
      config: project.config,
      module,
      assets: project.assets,
      wsServer,
      loadModules: browserModuleLoader(WORKERS_MODULE_SHIM),
      logs,
    });
    reply({ ok: true, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
