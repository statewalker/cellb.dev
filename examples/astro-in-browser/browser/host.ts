// The host tab: makes this origin cross-origin isolated (through the ServiceWorker), builds the
// app in a worker, and runs the built Worker on cellb (joinProjectShards).
import { joinProjectShards } from "@statewalker/cellb/browser";
import { pkgstoreConfig } from "../src/pkgstore/config.ts";
import pkgstoreSource from "../src/pkgstore/worker.js?raw";
import { crawlSite, zip } from "./export-site.ts";

const STORE = `${location.origin}/__cellb/projects/pkgstore`;
/** `?store`: packages through the package store Durable Object (see builder-worker.ts). */
const USE_STORE = new URLSearchParams(location.search).has("store");

/** The package store: a Durable Object project run by cellb in this tab (the builder's cache). */
async function startPackageStore(serviceWorker: () => Promise<ServiceWorker>) {
  await joinProjectShards({
    name: "pkgstore",
    shards: 1,
    // Its Durable Object on the LTX VFS: packs are read page by page from OPFS, never whole.
    bucket: { ltx: "pkgstore-ltx", node: "tab" },
    spawn: () => new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" }),
    config: pkgstoreConfig,
    code: { bundle: pkgstoreSource },
    assetFiles: new Map(),
    serviceWorker,
  });
  for (let i = 0; ; i++) {
    const r = await fetch(`${STORE}/files/ping`, { method: "HEAD" }).catch(() => undefined);
    if (r && (r.status === 404 || r.ok)) return;
    if (i > 300) throw new Error(`the package store does not answer (${r?.status})`);
    await new Promise((x) => setTimeout(x, 200));
  }
}

const status = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const say = (text: string) => (status.textContent = text);
const log = (line: string) => {
  console.info(`[build] ${line}`);
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

const APP = (document.body.dataset.app ?? "app") as "app" | "emdash";

async function sources(): Promise<Record<string, Uint8Array>> {
  const base = `${import.meta.env.BASE_URL}${APP}-src/`;
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

function build(
  src: Record<string, Uint8Array>,
): Promise<{ code: string; clientAssets: Map<string, Uint8Array> }> {
  const worker = new Worker(new URL("./builder-worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.log) log(e.data.log);
      else if (e.data.error) reject(new Error(e.data.error));
      else if (e.data.code) {
        log(`${e.data.routes} routes`);
        resolve({ code: e.data.code, clientAssets: e.data.clientAssets });
        worker.terminate();
      }
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({
      sources: src,
      integrations: APP === "emdash",
      store: USE_STORE ? STORE : undefined,
    });
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
  say("Starting the package store…");
  if (USE_STORE) await startPackageStore(serviceWorker);
  log("package store (a Durable Object on cellb) ready");
  say("Building the app in a worker…");
  const t0 = performance.now();
  // `?cached`: reuse the last build (kept in OPFS), to iterate on what runs after it.
  const opfs = await navigator.storage.getDirectory();
  const cacheName = `${APP}-build.json`;
  let built: { code: string; clientAssets: Map<string, Uint8Array> } | undefined;
  if (new URLSearchParams(location.search).has("cached")) {
    try {
      const f = await (await opfs.getFileHandle(cacheName)).getFile();
      const j = JSON.parse(await f.text());
      built = {
        code: j.code,
        clientAssets: new Map(j.assets.map(([k, v]: [string, number[]]) => [k, new Uint8Array(v)])),
      };
      log(`reusing the cached build (${(j.code.length / 1e6).toFixed(2)} MB)`);
    } catch {}
  }
  if (!built) {
    built = await build(src);
    const w = await (await opfs.getFileHandle(cacheName, { create: true })).createWritable();
    await w.write(
      JSON.stringify({
        code: built.code,
        assets: [...built.clientAssets].map(([k, v]) => [k, [...v]]),
      }),
    );
    await w.close();
  }
  const { code: bundle, clientAssets } = built;
  document.body.dataset.buildMs = String(Math.round(performance.now() - t0));
  say("Starting the built Worker on cellb…");
  log("starting the built Worker on cellb");
  await joinProjectShards({
    name: "app",
    shards: 1,
    spawn: () => {
      const w = new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" });
      w.addEventListener(
        "message",
        (e) => e.data?.shardLog && console.warn(`[shard] ${e.data.shardLog}`),
      );
      w.addEventListener("error", (e) =>
        console.warn(`[shard] worker error: ${e.message} ${e.filename}:${e.lineno}`),
      );
      return w;
    },
    config:
      APP === "emdash"
        ? emdashConfig()
        : {
            name: "app",
            main: "worker.js",
            compatibility_date: "2026-02-24",
            compatibility_flags: ["nodejs_compat"],
          },
    code: { bundle },
    assetFiles: clientAssets,
    serviceWorker,
  });
  log("shards joined; waiting for the site to answer");
  for (let i = 0; ; i++) {
    const r = await fetch("/").catch(() => undefined);
    if (r?.ok) break;
    if (i % 25 === 0)
      log(`GET / → ${r?.status}: ${(await r?.text().catch(() => ""))?.slice(0, 500)}`);
    if (i > 300) throw new Error("the built site does not answer");
    await new Promise((r) => setTimeout(r, 200));
  }
  say(`Running: built in ${document.body.dataset.buildMs} ms, served from this tab.`);
  document.body.dataset.ready = "true";
}

/** The EmDash template's bindings (wrangler.jsonc), and its canonical URL: this origin. */
function emdashConfig() {
  return {
    name: "emdash",
    main: "worker.js",
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: "emdash" }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "emdash-media" }],
    kv_namespaces: [{ binding: "SESSION" }],
    vars: { EMDASH_SITE_URL: location.origin },
    assets: { directory: "client", binding: "ASSETS", run_worker_first: false },
  };
}

/** Crawls the running site and downloads it as a ZIP of static files. */
async function exportSite() {
  say("Exporting the site…");
  const files = await crawlSite(log);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip(files));
  a.download = `${APP}-site.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  say(`Exported ${files.size} files.`);
  return [...files.keys()];
}
Object.assign(window, { __exportSite: exportSite });
document.getElementById("export")?.addEventListener("click", () => void exportSite());

start().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  say(`Failed: ${e?.message ?? e}`);
  log(String(e?.stack ?? e));
});
