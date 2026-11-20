/// <reference lib="webworker" />
// One cellb node for the capacity run: an example project and its container engine, kept open
// across steps. { op: "get", cell } asks a cell; { op: "close" } stops the node.
import { loadProject } from "@statewalker/cellb/browser";
import { Wasmer } from "@wasmer/sdk/browser";
import { wasmerContainerEngine } from "../../src/engine.ts";

let node:
  | Promise<{ project: Awaited<ReturnType<typeof loadProject>>; withdraw: () => Promise<void> }>
  | undefined;

self.addEventListener("message", async (e: MessageEvent) => {
  const reply = (v: unknown) => (e.ports[0] as MessagePort).postMessage(v);
  const { op, cell, project: name } = e.data as { op: string; cell?: string; project?: string };
  try {
    node ??= (async () => {
      const engine = wasmerContainerEngine(new Wasmer());
      const withdraw = () => engine.close();
      const project = await loadProject(
        new URL(`/built/${name ?? "python"}/`, location.href).href,
        { data: `cap-${Date.now()}`, containers: engine },
      );
      return { project, withdraw };
    })();
    const { project, withdraw } = await node;
    if (op === "get") {
      const res = await project.fetch(new Request(`http://localhost/cap?cell=${cell}`));
      reply({ status: res.status, body: await res.text() });
    } else if (op === "close") {
      await withdraw();
      await project.close();
      reply({ ok: true });
    }
  } catch (err) {
    reply({ error: String((err as Error)?.message ?? err).slice(0, 500) });
  }
});
