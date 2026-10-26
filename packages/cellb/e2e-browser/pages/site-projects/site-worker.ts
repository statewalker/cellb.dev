/// <reference lib="webworker" />
// Runs one project whose code comes from the in-browser HTTP server (webrun-site-host +
// webrun-site-builder + webrun-modules): `import()` of real URLs; Worker Loader over the site.

import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url";
import type { WranglerConfig } from "../../../src/index.js";
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
    const r = await runProject({
      name: job.name,
      scenario: job.scenario,
      config: job.config,
      code: { site: job.baseUrl },
      // Loaded Workers run isolated, each in its own Dedicated Worker (as celld's isolates).
      isolateScript: new URL(isolateWorker, import.meta.url),
      assets: job.assets,
      wsServer: job.wsServer,
      logs,
    });
    reply({ ok: true, moduleUrl: `${job.baseUrl}modules/~/${job.config.main}`, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
