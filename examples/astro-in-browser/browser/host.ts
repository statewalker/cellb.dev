// The host tab: makes this origin cross-origin isolated (through the ServiceWorker), builds the
// app in a worker, and runs the built Worker on cellb (joinProjectShards).
import { joinProjectShards } from "@statewalker/cellb/browser";

const status = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const say = (text: string) => (status.textContent = text);
const log = (line: string) => {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

async function serviceWorker(): Promise<ServiceWorker> {
  const script = import.meta.env.DEV ? `${import.meta.env.BASE_URL}sw.ts` : "/cellb-sw.js";
  await navigator.serviceWorker.register(script, { type: "module", scope: "/" });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((r) =>
      navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
    );
  return reg.active!;
}

async function sources(): Promise<Record<string, Uint8Array>> {
  const base = `${import.meta.env.BASE_URL}app-src/`;
  const list: string[] = await (await fetch(`${base}list.json`)).json();
  const out: Record<string, Uint8Array> = {};
  await Promise.all(
    list.map(
      async (p) =>
        (out[`/app${p}`] = new Uint8Array(await (await fetch(`${base}files${p}`)).arrayBuffer())),
    ),
  );
  return out;
}

function build(src: Record<string, Uint8Array>): Promise<string> {
  const worker = new Worker(new URL("./builder-worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.log) log(e.data.log);
      else if (e.data.error) reject(new Error(e.data.error));
      else if (e.data.code) {
        log(`routes: ${e.data.routes.join(" ")}`);
        resolve(e.data.code);
        worker.terminate();
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ sources: src });
  });
}

async function start() {
  say("Registering the ServiceWorker…");
  await serviceWorker();
  // The first load comes from the network, without COOP/COEP: reload once through the worker.
  if (!crossOriginIsolated) {
    if (!sessionStorage.getItem("coi-reload")) {
      sessionStorage.setItem("coi-reload", "1");
      location.reload();
      return;
    }
    throw new Error("not cross-origin isolated even after a reload through the ServiceWorker");
  }
  sessionStorage.removeItem("coi-reload");
  log(`cross-origin isolated: ${crossOriginIsolated} (headers added by the ServiceWorker)`);
  say("Reading the app's sources…");
  const src = await sources();
  log(`${Object.keys(src).length} source files: ${Object.keys(src).join(" ")}`);
  say("Building the app in a worker…");
  const t0 = performance.now();
  const bundle = await build(src);
  document.body.dataset.buildMs = String(Math.round(performance.now() - t0));
  say("Starting the built Worker on cellb…");
  await joinProjectShards({
    name: "app",
    shards: 1,
    spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
    config: {
      name: "app",
      main: "worker.js",
      compatibility_date: "2026-02-24",
      compatibility_flags: ["nodejs_compat"],
    },
    code: { bundle },
    assetFiles: new Map(),
    serviceWorker,
  });
  for (;;) {
    const r = await fetch("/").catch(() => undefined);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  say(`Running: built in ${document.body.dataset.buildMs} ms, served from this tab.`);
  document.body.dataset.ready = "true";
}

start().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  say(`Failed: ${e?.message ?? e}`);
  log(String(e?.stack ?? e));
});
