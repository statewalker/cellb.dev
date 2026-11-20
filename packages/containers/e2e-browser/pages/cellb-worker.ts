/// <reference lib="webworker" />
// A cellb node in a worker: an example project (cellb build output), its engine, and for the
// pool example a pool of containers whose runs mount FilesApis served on this thread.
import { loadProject } from "@statewalker/cellb/browser";
import { Wasmer } from "@wasmer/sdk/browser";
import { provideContainerEngine } from "../../src/container.ts";
import { wasmerContainerEngine } from "../../src/engine.ts";
import { HostMounts, installHostFiles } from "../../src/files/bridge.ts";
import { createContainerPool, provideContainerPool } from "../../src/pool.ts";

type Req = string | { path: string; method?: string; body?: string };

self.addEventListener("message", async (e: MessageEvent) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  try {
    const engine = wasmerContainerEngine(new Wasmer());
    const withdraw = provideContainerEngine(engine);
    const mounts = new HostMounts();
    const uninstall = installHostFiles(mounts);
    const pool = createContainerPool(engine, mounts, {
      image: { packages: ["python/python"] },
      size: 2,
    });
    const unprovide = provideContainerPool("python", pool);
    const project = await loadProject(
      new URL(`/built/${e.data.project ?? "python"}/`, location.href).href,
      {
        data: `e2e-${Date.now()}`,
        containers: engine, // objects of a containers class get ctx.container
      },
    );
    const out = [];
    for (const r of e.data.paths as Req[]) {
      const { path, method, body } = typeof r === "string" ? { path: r } : r;
      out.push(
        await (
          await project.fetch(new Request(`http://localhost${path}`, { method, body }))
        ).json(),
      );
    }
    unprovide();
    await pool.close();
    uninstall();
    await withdraw();
    await project.close();
    reply({ unsupported: project.unsupported, out });
  } catch (err) {
    reply({ error: String((err as Error)?.stack ?? err) });
  }
});
