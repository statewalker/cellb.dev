// Runs celld's counter example (index.js, unchanged) with this folder's wrangler.jsonc on cellb,
// shared by every open tab of the site. The project has SHARDS shards; each is a Dedicated
// Worker with its own OPFS pool, owned by one tab at a time through a Web Lock. The tabs split
// the shards between them, and take over the shards of a tab that closes, from the same files.
// Any tab can reach any cell: /demo/counter/… goes through the ServiceWorker (sw.ts) to the tab
// that runs the cell's shard.
import { parseJsonc, type WranglerConfig } from "@statewalker/cellb";
import { joinProjectShards } from "@statewalker/cellb/browser";
import code from "../../../../packages/cellb/conformance/celld-examples/counter/index.js?raw";
import wrangler from "./wrangler.jsonc?raw";

export const SHARDS = 2;

export function joinCounter(onChange: (owned: number[]) => void) {
  return joinProjectShards({
    name: "counter",
    shards: SHARDS,
    spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
    config: parseJsonc(wrangler) as WranglerConfig,
    code: { bundle: code },
    serviceWorker,
    onChange,
  });
}

/** A request from this tab, whichever tab runs the cell. */
export const fetchCounter = (name: string) =>
  fetch(`/demo/counter/?name=${encodeURIComponent(name)}`);

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
