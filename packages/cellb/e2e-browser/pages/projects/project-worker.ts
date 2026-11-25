/// <reference lib="webworker" />
// Runs one project bundled on the Node side (conformance/browser-bundle.ts); the bundle and
// Worker-Loader code are Blob-URL modules.

import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url";
import type { WranglerConfig } from "../../../src/index.js";
import { captureLogs, runProject } from "./run-project.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  // Several projects side by side in this one realm, as a fragment host's shard worker holds them
  // (#191): each its own runtime and OPFS pool, their scenarios run at once.
  if (Array.isArray(e.data?.jobs)) {
    const jobs = e.data.jobs as {
      project: {
        name: string;
        config: WranglerConfig;
        code: string | null;
        assets: [string, string][];
      };
      scenario: string;
      pool: string;
    }[];
    const results = await Promise.all(
      jobs.map((job) =>
        runProject({
          name: job.project.name,
          scenario: job.scenario,
          config: job.project.config,
          code: { bundle: job.project.code },
          isolateScript: new URL(isolateWorker, import.meta.url),
          assets: job.project.assets,
          pool: job.pool,
          logs: [],
        }).then(
          (r) => ({ ok: true, ...r }),
          (err) => ({ ok: false, error: String((err as Error)?.stack ?? err) }),
        ),
      ),
    );
    return reply(results);
  }
  const { project, scenario, wsServer, bucket, paths, pool } = e.data as {
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
    pool?: string;
  };
  const logs = captureLogs();
  try {
    const r = await runProject({
      name: project.name,
      scenario,
      config: project.config,
      code: { bundle: project.code },
      isolateScript: new URL(isolateWorker, import.meta.url),
      assets: project.assets,
      wsServer,
      bucket,
      paths,
      pool,
      logs,
    });
    reply({ ok: true, ...r });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
