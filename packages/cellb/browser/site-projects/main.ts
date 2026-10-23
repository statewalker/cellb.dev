// The page hosts each project on an in-browser HTTP server — a webrun-site-builder handler
// (compiled modules via webrun-modules) mounted by webrun-site-host in the ServiceWorker —
// and runs it in a Dedicated Worker that imports its code from that server.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";
import { createProjectSite } from "../../src/project/site.js";

interface Job {
  name: string;
  scenario: string;
  config: { main?: string };
  files: [string, string][]; // project files: path, base64
  assets: [string, string][];
  wsServer?: string;
}

(window as any).__runOnSite = async (job: Job) => {
  const projectFiles = new MemFilesApi();
  for (const [p, b64] of job.files)
    await projectFiles.write(p, [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);
  const nodeCompat = (
    (job.config as { compatibility_flags?: string[] }).compatibility_flags ?? []
  ).some((f) => f.startsWith("nodejs_compat"));
  // The served proxies take their export names from the registry entries (the worker binds them
  // to the same objects); the npm `util` polyfill reads `process` when it is imported.
  if (nodeCompat) (await import("../../src/node-compat/install.js")).installNodeGlobals();
  const nodeModules = nodeCompat
    ? (await import("../../src/node-compat/browser-registry.js")).nodeRegistryEntries
    : undefined;
  const site = await new HostedSiteBuilder()
    .setSiteKey(`site-${job.name}-${Math.random().toString(36).slice(2, 8)}`)
    .setHandler(createProjectSite({ projectFiles, nodeCompat, nodeModules }))
    .build();
  const worker = new Worker(new URL("./site-worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => resolve({ ...e.data, baseUrl: site.baseUrl });
      worker.onerror = (e) => resolve({ ok: false, error: e.message });
      worker.postMessage({ ...job, baseUrl: site.baseUrl }, [port2]);
    });
  } finally {
    worker.terminate();
    await site.stop();
  }
};
document.body.dataset.ready = "true";
