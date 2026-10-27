// A tab of the Flue app shared by every tab of the origin: it runs its share of the shards
// (joinProjectShards) and talks to the app through the ServiceWorker, with Flue's own client.
import { createFlueClient } from "@flue/sdk";
import type { WranglerConfig } from "@statewalker/cellb";
import { joinProjectShards, type ProjectTabs } from "@statewalker/cellb/browser";

async function serviceWorker(): Promise<ServiceWorker> {
  await navigator.serviceWorker.register(new URL("./sw.ts", import.meta.url), {
    type: "module",
    scope: "/",
  });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active!;
}

let tabs: ProjectTabs | undefined;
let name = "";
const workers: Worker[] = [];
const client = (id: string) =>
  createFlueClient({ url: `${location.origin}/app/${name}/agents/assistant/${id}` });

Object.assign(window, {
  __join: async (job: { name: string; shards: number; config: WranglerConfig; bundle: string }) => {
    name = job.name;
    tabs = await joinProjectShards({
      name: job.name,
      shards: job.shards,
      spawn: () => {
        const w = new Worker(new URL("./flue-shard-worker.ts", import.meta.url), {
          type: "module",
        });
        workers.push(w);
        return w;
      },
      config: job.config,
      code: { bundle: job.bundle },
      serviceWorker,
      onChange: (owned) => (document.body.dataset.owned = owned.join(",")),
      checkMs: 300,
    });
  },
  /** One whoami conversation each, all at once. */
  __whoami: (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        try {
          const c = client(id);
          const sent = await c.send({ message: { kind: "user", body: "whoami" } });
          return { id, text: (await c.read(sent)).text };
        } catch (err) {
          return { id, error: String(err) };
        }
      }),
    ),
  /** Leaves: this tab's shards are drained and handed to the other tabs. */
  __leave: () => tabs?.close(),
  /** The roles of a conversation's messages. */
  __history: async (id: string) => (await client(id).history()).messages.map((m) => m.role),
  /** What this tab's shard workers logged as warnings and errors. */
  __problems: async () =>
    (
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<string[]>((resolve) => {
              const { port1, port2 } = new MessageChannel();
              port1.onmessage = (e) => resolve(e.data);
              setTimeout(() => resolve([]), 1_000); // a worker already terminated
              w.postMessage({ type: "problems" }, [port2]);
            }),
        ),
      )
    ).flat(),
});

serviceWorker().then(
  () => (document.body.dataset.ready = "true"),
  (e) => (document.body.dataset.error = String(e?.stack ?? e)),
);
