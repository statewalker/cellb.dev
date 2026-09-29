// P05b — page side: competes for shard ownership with Web Locks; the tab holding
// the lock of shard i runs its worker and attaches it to the ServiceWorker router.
import { SHARDS } from "./config.js";

const owned = new Map<number, Worker>();
const log = (msg: string) => (document.getElementById("log")!.textContent += `${msg}\n`);

async function swReady(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register(new URL("./sw.ts", import.meta.url), {
    type: "module",
    scope: "./",
  });
  await navigator.serviceWorker.ready;
  return (reg.active ?? (await navigator.serviceWorker.ready).active)!;
}

function once(
  target: Worker | ServiceWorkerContainer,
  type: string,
  pred: (d: any) => boolean = () => true,
): Promise<any> {
  return new Promise((r) => {
    const h = (e: MessageEvent) => {
      if (e.data?.type === type && pred(e.data)) {
        target.removeEventListener("message", h as any);
        r(e.data);
      }
    };
    target.addEventListener("message", h as any);
  });
}

const ownerLocks = new Map<Worker, string>();

async function attach(shard: number, w: Worker): Promise<void> {
  const down = new MessageChannel(); // router → shard
  const up = new MessageChannel(); // shard → router
  const linked = once(w, "linked");
  w.postMessage({ type: "link", down: down.port2, up: up.port2 }, [down.port2, up.port2]);
  await linked;
  const sw = await swReady();
  const attached = once(navigator.serviceWorker, "cells-attached", (d) => d.shard === shard);
  sw.postMessage(
    { type: "cells-attach", shard, ownerLock: ownerLocks.get(w), down: down.port1, up: up.port1 },
    [down.port1, up.port1],
  );
  await attached;
}

async function own(shard: number): Promise<void> {
  await navigator.locks.request(`webrun-cells:shard:${shard}`, async () => {
    const w = new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" });
    const ready = once(w, "ready");
    w.postMessage({ type: "init", shard, shards: SHARDS });
    ownerLocks.set(w, (await ready).ownerLock);
    owned.set(shard, w);
    await attach(shard, w);
    log(`owner of shard ${shard}`);
    document.body.dataset.owned = [...owned.keys()].sort().join(",");
    await new Promise(() => {}); // hold the lock for the life of this tab
  });
}

navigator.serviceWorker.addEventListener("message", (e) => {
  if (e.data?.type === "cells-need-links") for (const [shard, w] of owned) void attach(shard, w); // SW restarted
});

(async () => {
  await swReady();
  document.body.dataset.ready = "true";
  // ?passive: a client of the cells that never competes for shard ownership.
  if (!new URL(location.href).searchParams.has("passive"))
    for (let s = 0; s < SHARDS; s++) void own(s);
})().catch((e) => (document.body.dataset.error = String(e?.stack ?? e)));
