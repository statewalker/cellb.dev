/// <reference lib="webworker" />
// A cellb node in a worker: an example project (cellb build output) and its engine.
import { loadProject } from "@statewalker/cellb/browser";
import { Wasmer } from "@wasmer/sdk/browser";
import { provideContainerEngine } from "../../src/container.ts";
import { wasmerContainerEngine } from "../../src/engine.ts";

self.addEventListener("message", async (e: MessageEvent) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    const wasmer = new Wasmer();
    const withdraw = provideContainerEngine(wasmerContainerEngine(wasmer));
    const project = await loadProject(
      new URL(`/built/${e.data.project ?? "python"}/`, location.href).href,
      {
        data: `e2e-${Date.now()}`,
      },
    );
    const out = [];
    for (const path of e.data.paths as string[])
      out.push(await (await project.fetch(new Request(`http://localhost${path}`))).json());
    await withdraw();
    await project.close();
    reply({ unsupported: project.unsupported, out });
  } catch (err) {
    reply({ error: String((err as Error)?.stack ?? err) });
  }
});
