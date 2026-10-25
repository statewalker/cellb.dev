/// <reference lib="webworker" />
// Runs one project bundled on the Node side (conformance/browser-bundle.ts); the bundle and
// Worker-Loader code are Blob-URL modules.

import type { WranglerConfig } from "../../src/project/wrangler.js";
import { captureLogs, runProject } from "./run-project.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
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
  try {
    const r = await runProject({
      name: project.name,
      scenario,
      config: project.config,
      code: { bundle: project.code },
      isolateScript: new URL("../isolate/isolate-worker.ts", import.meta.url),
      assets: project.assets,
      wsServer,
      bucket,
      paths,
      logs,
    });
    reply({ ok: true, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
