// A tab of a project shared by every tab of the origin: it takes its share of the shards
// (joinProjectShards) and sends requests through the ServiceWorker's router.
import {
  joinProjectShards,
  type ProjectTabs,
  serviceWorkerConnector,
} from "../../../src/browser.js";
import { createWebSocketClass, type WranglerConfig } from "../../../src/index.js";

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
  /** Joins one more project (`__join` keeps the first): two projects on one ServiceWorker. */
  __joinAnother: async (job: {
    name: string;
    shards: number;
    config: WranglerConfig;
    code: string;
  }) => {
    others.push(
      await joinProjectShards({
        name: job.name,
        shards: job.shards,
        spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
        config: job.config,
        code: { bundle: job.code },
        serviceWorker,
        checkMs: 300,
      }),
    );
    return true;
  },
  /** A request to project `project` (default: the joined one), with its init. */
  __request: async (path: string, init: RequestInit = {}, project = name) => {
    const res = await fetch(`/tabs/app/${project}${path}`, init);
    return { status: res.status, body: await res.text() };
  },
  /** A socket to the project through the ServiceWorker: sends `message`, returns the first reply. */
  __socket: async (path: string, message: string, project = name) => {
    const WS = createWebSocketClass(serviceWorkerConnector());
    const ws = new WS(
      new URL(`/tabs/app/${project}${path}`, location.href).href.replace(/^http/, "ws"),
    );
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send(message);
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    ws.close();
    return reply;
  },
});
const others: ProjectTabs[] = [];

serviceWorker().then(
  () => (document.body.dataset.ready = "true"),
  (e) => (document.body.dataset.error = String(e?.stack ?? e)),
);
