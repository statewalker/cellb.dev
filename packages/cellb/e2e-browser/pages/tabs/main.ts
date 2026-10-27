// A tab of a project shared by every tab of the origin: it takes its share of the shards
// (joinProjectShards) and sends requests through the ServiceWorker's router.
import { joinProjectShards, type ProjectTabs } from "../../../src/browser.js";
import type { WranglerConfig } from "../../../src/index.js";

async function serviceWorker(): Promise<ServiceWorker> {
  await navigator.serviceWorker.register(new URL("./sw.ts", import.meta.url), {
    type: "module",
    scope: "./",
  });
  const reg = await navigator.serviceWorker.ready;
  // Requests must go through it: wait until it controls this page (clients.claim()).
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active!;
}

let tabs: ProjectTabs | undefined;
let name = "";
Object.assign(window, {
  /** Joins the project: this tab runs its share of `shards` shards. */
  __join: async (job: { name: string; shards: number; config: WranglerConfig; code: string }) => {
    name = job.name;
    tabs = await joinProjectShards({
      name: job.name,
      shards: job.shards,
      spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
      config: job.config,
      code: { bundle: job.code },
      serviceWorker,
      onChange: (owned) => (document.body.dataset.owned = owned.join(",")),
      checkMs: 300,
    });
    return true;
  },
  /** A request to the project's Worker, through the ServiceWorker. */
  __fetch: async (path: string) => {
    const res = await fetch(`/tabs/app/${name}${path}`);
    return { status: res.status, body: await res.text() };
  },
  __leave: () => tabs?.close(),
});

serviceWorker().then(
  () => (document.body.dataset.ready = "true"),
  (e) => (document.body.dataset.error = String(e?.stack ?? e)),
);
