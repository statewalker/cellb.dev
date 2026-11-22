/// <reference lib="webworker" />
// Hosts the app in this Dedicated Worker: cellb loads the folder written by `cellb build`
// (`/app/`), its Durable Objects keep SQLite on OPFS, and Worker Loader isolates run in workers
// of their own. Requests come from the page (main.ts) as messages.

import { loadProject } from "@statewalker/cellb/browser";

type Project = Awaited<ReturnType<typeof loadProject>>;
let project: Project | undefined;

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e) => {
  const port = e.ports[0] as MessagePort;
  const msg = e.data as
    | { type: "start"; data: string }
    | { type: "fetch"; path: string; method: string; body?: ArrayBuffer }
    | { type: "stop" };
  try {
    if (msg.type === "start") {
      project = await loadProject(new URL("/app/", scope.location.origin).href, { data: msg.data });
      port.postMessage({ ok: true, unsupported: project.unsupported });
    } else if (msg.type === "fetch") {
      if (!project) throw new Error("the app is not loaded");
      const res = await project.fetch(
        new Request(`http://app.test${msg.path}`, { method: msg.method, body: msg.body }),
      );
      const body = await res.arrayBuffer();
      port.postMessage({ status: res.status, contentType: res.headers.get("content-type"), body }, [
        body,
      ]);
    } else {
      await project?.close();
      project = undefined;
      port.postMessage({ ok: true });
    }
  } catch (err) {
    port.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
