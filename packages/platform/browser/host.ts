// The host tab: registers the origin's ServiceWorker and runs the platform's shard in a Dedicated
// Worker (cellb's joinProjectShards); the origin's requests then reach the platform through it.
import type { WranglerConfig } from "@statewalker/cellb";
import { joinProjectShards, type ProjectTabs } from "@statewalker/cellb/browser";

const status = document.getElementById("status") as HTMLElement;
const say = (text: string) => {
  status.textContent = text;
};

async function serviceWorker(): Promise<ServiceWorker> {
  await navigator.serviceWorker.register("/cellb-sw.js", { type: "module", scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active as ServiceWorker;
}

let tabs: ProjectTabs | undefined;

async function start() {
  say("Registering the ServiceWorker…");
  await serviceWorker();
  // The first load comes from the network, without COOP/COEP: reload once through the worker,
  // which adds them (Astro builds need a cross-origin isolated realm for the compiler's memory).
  if (!globalThis.crossOriginIsolated) {
    if (!sessionStorage.getItem("webrun-coi-reload")) {
      sessionStorage.setItem("webrun-coi-reload", "1");
      location.reload();
      return;
    }
    say("Not cross-origin isolated: Astro builds will fail (the other apps work).");
  }
  say("Loading the platform…");
  const app = async (p: string) => {
    const r = await fetch(`/__cellb/app/${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r;
  };
  const config: WranglerConfig = await (await app("wrangler.json")).json();
  const bundle = await (await app("worker.js")).text();
  say(`Starting the platform (${(bundle.length / 1e6).toFixed(1)} MB of code)…`);
  tabs = await joinProjectShards({
    name: "platform",
    shards: 1,
    spawn: () => new Worker("/__cellb/shard-worker.js", { type: "module" }),
    config,
    code: { bundle },
    assetFiles: new Map(),
    serviceWorker,
    onChange: (owned) => {
      document.body.dataset.owned = owned.join(",");
    },
  });
  for (;;) {
    const r = await fetch("/").catch(() => undefined);
    if (r?.ok && (await r.text()).includes("webrun platform")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  say(
    `Running: the platform is served from this tab${globalThis.crossOriginIsolated ? " (cross-origin isolated)" : ""}.`,
  );
  document.body.dataset.ready = "true";
}

Object.assign(window, { __leave: () => tabs?.close() });

start().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  say(`Failed: ${e?.stack ?? e}`);
});
