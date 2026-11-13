// The host tab: makes this origin cross-origin isolated (through the ServiceWorker), builds the
// app in a worker, and runs the built Worker on cellb (joinProjectShards).
import { joinProjectShards } from "@statewalker/cellb/tabs";
import { pkgstoreConfig } from "../src/pkgstore/config.ts";
import pkgstoreSource from "../src/pkgstore/worker.js?raw";
import { crawlSite, zip } from "./export-site.ts";

const STORE = `${location.origin}/__cellb/projects/pkgstore`;
/**
 * Packages through the package store Durable Object (see builder-worker.ts), the default;
 * `?memory`: in the builder's memory only, fetched from the registry on every build.
 */
const USE_STORE = !new URLSearchParams(location.search).has("memory");

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
      else if (e.data.error) {
        // The worker has stopped its downloads and given its lease back: nothing of it is left.
        worker.terminate();
        reject(new Error(e.data.error));
      } else if (e.data.code) {
        log(`${e.data.routes} routes`);
        worker.terminate();
        resolve({ code: new TextDecoder().decode(e.data.code), clientAssets: e.data.clientAssets });
      }
    };
    worker.onerror = (e) => {
      worker.terminate(); // its lease lapses within a minute
      reject(new Error(e.message));
    };
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
  if (USE_STORE) {
    await startPackageStore(serviceWorker);
    log("package store (a Durable Object on cellb) ready");
    await showPackageCache();
  }
  say("Building the app in a worker…");
  const t0 = performance.now();
  // (A debugging cache of the build, written here as JSON with every asset byte as a number,
  // held ~370 MB on the page's heap: removed.)
  const built = await build(src);
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
    // The site's Durable Objects (D1, KV, R2 included) on cellb's LTX storage: SQLite in the
    // shard over LTX files on OPFS (celld's layout), read by page, compacted in the background.
    // `?pools`: cellb's OPFS pools instead.
    ...(new URLSearchParams(location.search).has("pools")
      ? {}
      : { bucket: { ltx: `${APP}-ltx`, node: "tab" } }),
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
  // For the chooser (start.html): which app this origin serves now.
  try {
    localStorage.setItem("cellb:last-build", JSON.stringify({ app: APP, at: Date.now() }));
  } catch {}
  // Sent here by the chooser for a path of the site (?next=): the link opens that path.
  const next = new URLSearchParams(location.search).get("next");
  const open = document.getElementById("open") as HTMLAnchorElement | null;
  if (open && next?.startsWith("/") && !next.startsWith("//")) {
    open.href = next;
    open.textContent = `Open ${next}`;
  }
  if (USE_STORE) await showPackageCache(false);
}

// --- The package cache: statistics and clean-up (the package store's /admin/* routes) ---

type CacheStats = {
  files: number;
  packages: number;
  locks: number;
  size: number;
  stored: number;
  /** Builds holding a lease on the store (this tab or another): a clean-up waits for them. */
  builds: number;
};
type CacheOp = "stats" | "prune" | "forget" | "clear";
const CACHE_ROUTES: Record<CacheOp, [string, string]> = {
  stats: ["GET", "admin/stats"],
  prune: ["POST", "admin/prune"], // the packs no build's lock names
  forget: ["POST", "admin/forget"], // the locks and the version index: versions resolved again
  clear: ["POST", "admin/clear"], // every package, the version index and the locks
};

/**
 * Runs one operation on the package store: its statistics afterwards (and `removed`). A
 * clean-up while a build uses the store (409) throws the store's reason.
 */
async function packageCache(op: CacheOp): Promise<CacheStats & { removed?: number }> {
  const [method, path] = CACHE_ROUTES[op];
  const r = await fetch(`${STORE}/${path}`, { method });
  if (!r.ok) {
    const text = await r.text();
    let reason = text;
    try {
      reason = JSON.parse(text).error ?? text;
    } catch {}
    throw new Error(
      r.status === 409 ? reason : `package store: ${method} ${path} → ${r.status}: ${reason}`,
    );
  }
  return r.json();
}

const cacheEl = document.getElementById("cache");
const cacheButtons = () => [...(cacheEl?.querySelectorAll("button") ?? [])];
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** Shows the panel and the store's statistics; `busy`: its buttons wait (a build reads the store). */
async function showPackageCache(busy = true) {
  if (!cacheEl) return;
  cacheEl.hidden = false;
  for (const b of cacheButtons()) b.disabled = busy;
  const out = document.getElementById("cache-stats");
  if (!out) return;
  try {
    const s = await packageCache("stats");
    out.textContent = `${s.packages} packages, ${s.locks} lock${s.locks === 1 ? "" : "s"}: ${mb(s.size)} (${mb(s.stored)} stored)${s.builds ? `; ${s.builds} build${s.builds === 1 ? "" : "s"} using it` : ""}`;
  } catch (e) {
    out.textContent = `unavailable (${(e as Error).message})`;
  }
}

async function cleanPackageCache(op: Exclude<CacheOp, "stats">) {
  if (op === "clear" && !confirm("Remove every package? The next build downloads them again."))
    return;
  for (const b of cacheButtons()) b.disabled = true;
  try {
    const r = await packageCache(op);
    log(
      `package cache: ${op}: ${r.removed ?? 0} files removed; ${r.packages} packages left (${mb(r.size)})`,
    );
    if ((document.getElementById("cache-rebuild") as HTMLInputElement | null)?.checked) {
      say("Rebuilding…");
      location.reload();
      return;
    }
  } catch (e) {
    log(`package cache: ${op} failed: ${(e as Error).message}`);
  }
  await showPackageCache(false);
}
for (const b of cacheButtons())
  b.addEventListener("click", () => void cleanPackageCache(b.dataset.cache as never));
// For the tests and the console: `await __packageCache("prune")`.
Object.assign(window, { __packageCache: packageCache });

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
    // The template's maintenance cron: its src/worker.ts, the built entry, has scheduled().
    triggers: { crons: ["* * * * *"] },
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

// Memory by realm (page, each worker), every 10 s: what fills the tab (cross-origin isolated
// pages only; the measurement waits for a garbage collection, so it can lag).
const measure = (
  performance as {
    measureUserAgentSpecificMemory?: () => Promise<{
      bytes: number;
      breakdown: { bytes: number; attribution: { url?: string; scope?: string }[] }[];
    }>;
  }
).measureUserAgentSpecificMemory;
if (measure && crossOriginIsolated)
  setInterval(async () => {
    try {
      const m = await measure.call(performance);
      const by = new Map<string, number>();
      for (const b of m.breakdown)
        for (const a of b.attribution.length ? b.attribution : [{ url: "(shared)" }]) {
          const k =
            (a.url ?? a.scope ?? "?").replace(/^.*\/(__cellb\/)?/, "").split("?")[0] || "(page)";
          by.set(k, (by.get(k) ?? 0) + b.bytes / Math.max(1, b.attribution.length));
        }
      const top = [...by]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k} ${(v / 1e6).toFixed(0)}MB`);
      console.info(`[memory] total ${(m.bytes / 1e6).toFixed(0)} MB: ${top.join(", ")}`);
    } catch {}
  }, 10_000);

start().catch((e) => {
  document.body.dataset.error = String(e?.stack ?? e);
  // A failed build may come from what the cache holds: its clean-up stays available.
  if (USE_STORE && cacheEl && !cacheEl.hidden) void showPackageCache(false);
  say(`Failed: ${e?.message ?? e}`);
  log(String(e?.stack ?? e));
});
