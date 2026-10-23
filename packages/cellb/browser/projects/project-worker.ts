/// <reference lib="webworker" />
// Runs one project bundled on the Node side (conformance/browser-bundle.ts); the bundle and
// Worker-Loader code are Blob-URL modules.

import { cellsCaches } from "../../src/bindings/cache.js";
import { browserIsolatedLoader } from "../../src/isolate/browser.js";
import { installNodeGlobals } from "../../src/node-compat/install.js";
import { browserModuleLoader } from "../../src/project/browser-modules.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import type { WranglerConfig } from "../../src/project/wrangler.js";
import {
  CellsResponse,
  HTMLRewriter,
  WebSocketPair,
  WebSocketRequestResponsePair,
} from "../../src/ws/server.js";
import { captureLogs, runProject } from "./run-project.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const WORKERS_MODULE_SHIM =
  "const m = globalThis.__cellsWorkersModule; export const DurableObject = m.DurableObject, WorkerEntrypoint = m.WorkerEntrypoint, WorkflowEntrypoint = m.WorkflowEntrypoint, RpcTarget = m.RpcTarget; export default m;";

scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { project, scenario, wsServer, bucket, paths } = e.data as {
    project: {
      name: string;
      config: WranglerConfig;
      code: string | null;
      assets: [string, string][];
    };
    scenario: string;
    wsServer?: string;
    bucket?: Parameters<typeof runProject>[0]["bucket"];
    paths?: string[];
  };
  const logs = captureLogs();
  const cfg = (e.data.project?.config ?? e.data.config) as WranglerConfig;
  if ((cfg?.compatibility_flags ?? []).some((f) => f.startsWith("nodejs_compat")))
    installNodeGlobals();
  try {
    const g = globalThis as Record<string, unknown>;
    g.__cellsWorkersModule = workersModule;
    g.__cellsGlobals = {
      Response: CellsResponse,
      WebSocketPair,
      caches: cellsCaches,
      HTMLRewriter,
      WebSocketRequestResponsePair,
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
      bucket,
      paths,
      loadModules: browserModuleLoader(WORKERS_MODULE_SHIM),
      isolatedModules: browserIsolatedLoader({
        isolateScript: new URL("../isolate/isolate-worker.ts", import.meta.url),
        storagePrefix: `iso-${project.name}-${Date.now().toString(36)}`,
      }),
      logs,
    });
    reply({ ok: true, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
