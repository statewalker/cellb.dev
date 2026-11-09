// The page side of the demo: every open tab of the site joins the project. The project has
// SHARDS shards; each is a Dedicated Worker (shard-worker.ts) with its own OPFS pool, run by one
// tab at a time through a Web Lock. The tabs split the shards between them and take over the
// shards of a tab that closes. Any tab reaches any object: /demo/counter-v2/… goes through the
// ServiceWorker (sw.ts) to the tab that runs the object's shard.
import type { WranglerConfig } from "@statewalker/cellb";
import { joinProjectShards } from "@statewalker/cellb/browser";

export const SHARDS = 2;

/** The folder `cellb build project --out public/built/demo-counter` writes. */
const BUILT = "/built/demo-counter";

export async function joinCounter(onChange: (owned: number[]) => void) {
  const config = (await (await fetch(`${BUILT}/wrangler.json`)).json()) as WranglerConfig;
  const bundle = await (await fetch(`${BUILT}/worker.js`)).text();
  return joinProjectShards({
    // The project's name: its shards' OPFS pools are named after it (a fresh store for this Counter).
    name: "counter-v2",
    shards: SHARDS,
    spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
    config,
    code: { bundle },
    serviceWorker,
    onChange,
  });
}

/** A request from this tab, whichever tab runs the object. */
export const fetchCounter = (name: string) =>
  fetch(`/demo/counter-v2/?name=${encodeURIComponent(name)}`);

async function serviceWorker(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register("/cellb-demo-sw.js");
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  const active = reg.active ?? (await navigator.serviceWorker.ready).active;
  if (!active) throw new Error("the demo's ServiceWorker did not start");
  return active;
}
