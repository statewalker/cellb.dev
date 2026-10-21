/// <reference lib="webworker" />
// Runs one project whose code comes from the in-browser HTTP server (webrun-site-host +
// webrun-site-builder + webrun-modules): `import()` of real URLs; Worker Loader over the site.

import { cellsCaches } from "../../src/bindings/cache.js";
import * as workersModule from "../../src/project/cloudflare-workers.js";
import { siteModuleLoader, workersHostRegistry } from "../../src/project/site.js";
import type { WranglerConfig } from "../../src/project/wrangler.js";
import { CellsResponse, HTMLRewriter, WebSocketPair } from "../../src/ws/server.js";
import { captureLogs, runProject } from "../projects/run-project.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const job = e.data as {
    name: string;
    baseUrl: string;
    config: WranglerConfig;
    assets: [string, string][];
    scenario: string;
    wsServer?: string;
  };
  const logs = captureLogs();
  try {
    workersHostRegistry({
      workersModule,
      Response: CellsResponse,
      WebSocketPair,
      caches: cellsCaches,
      HTMLRewriter,
    });
    const module = job.config.main
      ? await import(/* @vite-ignore */ `${job.baseUrl}modules/~/${job.config.main}`)
      : { default: {} };
    const r = await runProject({
      name: job.name,
      scenario: job.scenario,
      config: job.config,
      module,
      assets: job.assets,
      wsServer: job.wsServer,
      loadModules: siteModuleLoader(job.baseUrl),
      logs,
    });
    reply({ ok: true, moduleUrl: `${job.baseUrl}modules/~/${job.config.main}`, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
