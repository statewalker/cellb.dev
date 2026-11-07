/// <reference lib="webworker" />
// loadProject from @statewalker/cellb/browser: the URL of a `cellb build` folder and an OPFS
// name, nothing else (SQLite WASM and the isolate worker are the package's own).
import { loadProject } from "@statewalker/cellb/browser";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { url, data, runs } = e.data as { url: string; data: string; runs: string[][] };
  try {
    const out: { status: number; type: string | null; body: string }[][] = [];
    let name = "";
    let unsupported: string[] = [];
    // Each run loads the project afresh (same `data`), then closes it.
    for (const paths of runs) {
      const project = await loadProject(url, { data });
      name = project.config.name ?? "";
      unsupported = project.unsupported;
      const responses = [];
      for (const path of paths) {
        const res = await project.fetch(new Request(`http://localhost${path}`));
        responses.push({
          status: res.status,
          type: res.headers.get("content-type"),
          body: await res.text(),
        });
      }
      await project.close();
      out.push(responses);
    }
    reply({ ok: true, name, unsupported, out });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
