// The host tab: registers the origin's ServiceWorker and runs the EmDash project's shard in a
// Dedicated Worker (joinProjectShards); pages of the site then reach it through the ServiceWorker.
import type { WranglerConfig } from "@statewalker/cellb";
import { joinProjectShards, type ProjectTabs } from "@statewalker/cellb/tabs";

const status = document.getElementById("status")!;
const say = (text: string) => (status.textContent = text);

async function serviceWorker(): Promise<ServiceWorker> {
  // One self-contained file at the origin's root (browser/vite.sw.config.ts), in the static build
  // and under the dev server alike: a module ServiceWorker cannot run Vite's dev modules (they use
  // dynamic import()), and at the root it controls the whole origin from any file server.
  await navigator.serviceWorker.register("/cellb-sw.js", { type: "module", scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active!;
}

const workers: Worker[] = [];
let tabs: ProjectTabs | undefined;

async function start() {
  say("Registering the ServiceWorker…");
  await serviceWorker();
  say("Loading the app…");
  // The dev server answers a missing build with 404 and what to run; show that, not a parse error.
  const app = async (p: string) => {
    const r = await fetch(`${import.meta.env.BASE_URL}app/${p}`);
    if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
    return r;
  };
  const config: WranglerConfig = await (await app("config.json")).json();
  // EmDash's canonical URL: on Cloudflare it reads EMDASH_SITE_URL from process.env, which
  // nodejs_compat fills with the text vars (cellb does too); here, this origin.
  config.vars = { ...config.vars, EMDASH_SITE_URL: location.origin };
  const bundle = await (await app("worker.js")).text();
  const paths: string[] = await (await app("assets.json")).json();
  const assetFiles = new Map<string, Uint8Array>();
  await Promise.all(
    paths.map(async (p) =>
      assetFiles.set(p, new Uint8Array(await (await app(`assets${p}`)).arrayBuffer())),
    ),
  );
  say(
    `Starting the project (${(bundle.length / 1e6).toFixed(1)} MB of code, ${paths.length} assets)…`,
  );
  tabs = await joinProjectShards({
    name: "emdash",
    shards: 1,
    spawn: () => {
      const w = new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" });
      workers.push(w);
      return w;
    },
    config,
    code: { bundle },
    assetFiles,
    serviceWorker,
    onChange: (owned) => (document.body.dataset.owned = owned.join(",")),
  });
  // The project answers once its shard is up.
  for (;;) {
    const r = await fetch("/_emdash/api/setup/status").catch(() => undefined);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  say("Running: the site is served from this tab.");
  // Sent here by the ServiceWorker because no tab ran the site: offer the page asked for. It
  // opens in a new tab, as this one must stay open to serve it.
  const next = new URLSearchParams(location.search).get("next");
  if (next?.startsWith("/") && !next.startsWith("//")) {
    const p = document.getElementById("next")!;
    const a = p.querySelector("a")!;
    a.href = next;
    a.textContent = next;
    p.hidden = false;
  }
  document.body.dataset.ready = "true";
}

Object.assign(window, {
  /** What the shard workers logged as errors. */
  __problems: async () =>
    (
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<string[]>((resolve) => {
              const { port1, port2 } = new MessageChannel();
              port1.onmessage = (e) => resolve(e.data);
              setTimeout(() => resolve([]), 1_000);
              w.postMessage({ type: "problems" }, [port2]);
            }),
        ),
      )
    ).flat(),
  __leave: () => tabs?.close(),
});

start().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  say(`Failed: ${e?.stack ?? e}`);
});
