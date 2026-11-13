// The host tab: makes this origin cross-origin isolated (through the ServiceWorker), builds the
// app in a worker, and runs the built Worker on cellb (joinProjectShards).
import { joinProjectShards } from "@statewalker/cellb/tabs";
import { pkgstoreConfig } from "../src/pkgstore/config.ts";
import pkgstoreSource from "../src/pkgstore/worker.js?raw";
import { type AppName, loadBuild, type SavedBuild, saveBuild, savedBuildMeta } from "./builds.ts";
import { crawlSite, zip } from "./export-site.ts";
import { nextPath } from "./next-path.ts";

const STORE = `${location.origin}/__cellb/projects/pkgstore`;
/**
 * Packages through the package store Durable Object (see builder-worker.ts), the default;
 * `?memory`: in the builder's memory only, fetched from the registry on every build.
 */
const USE_STORE = !new URLSearchParams(location.search).has("memory");
/**
 * The app runs from its saved build (builds.ts) when there is one; `?rebuild` compiles it again
 * (and saves the new build).
 */
const REBUILD = new URLSearchParams(location.search).has("rebuild");
/** This page's URL with `?rebuild`, its other parameters kept. */
function rebuildURL(): string {
  const q = new URLSearchParams(location.search);
  q.set("rebuild", "");
  return `${location.pathname}?${q.toString().replace(/rebuild=(&|$)/, "rebuild$1")}`;
}

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
  advance(line);
};

// --- Progress: the build's stages, read from its log lines, and the time spent so far ---

/**
 * Where a log line puts the start of the app, in percent, and the stage it begins. The weights
 * follow a cold EmDash build (the server bundle takes the longest); a small app skips stages.
 */
const STAGES: [RegExp, number, string][] = [
  [/^cross-origin isolated/, 2, "Reading the sources"],
  [/^saved build of /, 80, "Starting the saved build"],
  [/^package store \(a Durable Object/, 4, "Starting the compilers"],
  [/^esbuild-wasm .* ready/, 6, "Loading Astro's compiler"],
  [/^Astro's compiler .* ready/, 9, "Fetching packages"],
  [/^package cache: /, 11, "Fetching packages"],
  [/^preloading the packages/, 13, "Preloading the packages the integrations read"],
  [/^build-time file system/, 24, "Running astro.config.mjs"],
  [/^astro\.config\.mjs bundled/, 28, "Running the integrations"],
  [/^integrations: /, 33, "Reading the routes"],
  [/^\d+ routes/, 35, "Scanning the components"],
  [/bundling the server$/, 38, "Bundling the server (the longest stage)"],
  [/^bundling the client/, 74, "Bundling the client"],
  [/^built in /, 86, "Storing the packages"],
  [/^package store: \d+ packages downloaded/, 89, "Saving the build"],
  [/^build saved|^build not saved/, 91, "Starting the built Worker"],
  [/^starting the built Worker/, 93, "Starting the built Worker on cellb"],
  [/^shards joined/, 96, "Waiting for the site to answer"],
];
const progressEl = document.getElementById("progress") as HTMLProgressElement | null;
const phaseEl = document.getElementById("phase");
let percent = 0;
let phase = "Starting";
/** Packages downloaded so far: shown beside the stage (downloads go on during the bundles). */
let downloaded = 0;
const startedAt = performance.now();
const elapsed = () => `${Math.round((performance.now() - startedAt) / 1000)} s`;
function showProgress() {
  if (progressEl) progressEl.value = percent;
  const packages = downloaded ? ` · ${downloaded} packages downloaded` : "";
  if (phaseEl) phaseEl.textContent = `${phase}${packages} · ${percent}% · ${elapsed()}`;
}
function advance(line: string) {
  const downloads = /^downloading packages: (\d+)/.exec(line);
  if (downloads) downloaded = Number(downloads[1]);
  const total = /^package store: (\d+) packages downloaded/.exec(line);
  if (total) downloaded = Number(total[1]);
  for (const [re, at, next] of STAGES)
    if (re.test(line) && at >= percent) {
      percent = at;
      phase = next;
    }
  showProgress();
}
const ticker = setInterval(showProgress, 1000);
/** The end of the progress: done, or failed. */
function finishProgress(ok: boolean) {
  clearInterval(ticker);
  percent = ok ? 100 : percent;
  phase = ok ? "Running" : "Failed";
  showProgress();
  document.getElementById("progress-box")?.toggleAttribute("data-failed", !ok);
}

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

const APP = (document.body.dataset.app ?? "app") as AppName;

/**
 * The bundle stages move the progress bar by the modules loaded so far, against what the last
 * build of this app loaded (its saved build's `modules`), or else about what a build of it
 * loads.
 */
const BUNDLES: Record<string, { from: number; to: number; label: string }> = {
  server: { from: 38, to: 74, label: "Bundling the server" },
  client: { from: 74, to: 86, label: "Bundling the client" },
};
/** Measured (EmDash 1.5: 3195 and 7051; the small app's client bundles load none). */
const EXPECTED_MODULES: Record<AppName, { server: number; client: number }> = {
  app: { server: 300, client: 0 },
  emdash: { server: 3200, client: 7050 },
};
let expectedModules = EXPECTED_MODULES[APP];
void savedBuildMeta(APP).then((m) => {
  if (m?.modules?.server) expectedModules = m.modules;
});
function bundleProgress(stage: string, modules: number) {
  const b = BUNDLES[stage];
  const expected = expectedModules[stage as "server" | "client"];
  if (!b || !expected) return;
  // Short of the stage's end: the count is an estimate, and the stage ends with its log line.
  const at = Math.round(b.from + (b.to - b.from) * Math.min(0.97, modules / expected));
  if (at < percent) return;
  percent = at;
  phase = `${b.label} (${modules} modules)`;
  showProgress();
}

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

function build(src: Record<string, Uint8Array>): Promise<{
  code: string;
  clientAssets: Map<string, Uint8Array>;
  routes: number;
  modules?: { server: number; client: number };
}> {
  const worker = new Worker(new URL("./builder-worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.log) log(e.data.log);
      else if (e.data.progress) bundleProgress(e.data.progress.stage, e.data.progress.modules);
      else if (e.data.error) {
        // The worker has stopped its downloads and given its lease back: nothing of it is left.
        worker.terminate();
        reject(new Error(e.data.error));
      } else if (e.data.code) {
        log(`${e.data.routes} routes`);
        worker.terminate();
        resolve({
          code: new TextDecoder().decode(e.data.code),
          clientAssets: e.data.clientAssets,
          routes: e.data.routes,
          modules: e.data.modules,
        });
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
  // The saved build, unless asked to compile again.
  const saved: SavedBuild | undefined = REBUILD
    ? undefined
    : await loadBuild(APP).catch((err) => {
        log(`saved build: cannot be read (${err?.message ?? err}); compiling`);
        return undefined;
      });
  say("Starting the package store…");
  if (USE_STORE) {
    await startPackageStore(serviceWorker);
    log("package store (a Durable Object on cellb) ready");
    await showPackageCache();
  }
  let bundle: string;
  let clientAssets: Map<string, Uint8Array>;
  if (saved) {
    const when = new Date(saved.meta.at).toLocaleString();
    log(
      `saved build of ${when}: ${saved.meta.routes} routes, ${(saved.meta.codeBytes / 1e6).toFixed(2)} MB; running it (Rebuild compiles the sources again)`,
    );
    document.body.dataset.saved = String(saved.meta.at);
    document.body.dataset.buildMs = "0";
    ({ code: bundle, clientAssets } = saved);
  } else {
    say("Reading the app's sources…");
    const src = await sources();
    log(`${Object.keys(src).length} source files: ${Object.keys(src).join(" ")}`);
    say("Building the app in a worker…");
    const t0 = performance.now();
    const built = await build(src);
    ({ code: bundle, clientAssets } = built);
    const buildMs = Math.round(performance.now() - t0);
    document.body.dataset.buildMs = String(buildMs);
    // Kept until the app is built again: the next visit runs it without compiling.
    try {
      const meta = await saveBuild(APP, {
        code: bundle,
        clientAssets,
        buildMs,
        routes: built.routes,
        modules: built.modules,
      });
      log(
        `build saved (${(meta.codeBytes / 1e6).toFixed(2)} MB, ${meta.assets.length} assets): the next visit runs it`,
      );
    } catch (err) {
      log(`build not saved: ${(err as Error)?.message ?? err}`);
    }
    // A reload runs the saved build; it does not compile again.
    if (REBUILD) {
      const q = new URLSearchParams(location.search);
      q.delete("rebuild");
      history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
    }
  }
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
    if (i > 300)
      throw new Error(
        `the built site does not answer${saved ? " (a saved build: Rebuild compiles it again)" : ""}`,
      );
    await new Promise((r) => setTimeout(r, 200));
  }
  say(
    saved
      ? `Running the build saved ${new Date(saved.meta.at).toLocaleString()}, served from this tab (Rebuild compiles it again).`
      : `Running: built in ${document.body.dataset.buildMs} ms, served from this tab.`,
  );
  document.body.dataset.ready = "true";
  finishProgress(true);
  // For the chooser (start.html): which app this origin serves now.
  try {
    localStorage.setItem("cellb:last-build", JSON.stringify({ app: APP, at: Date.now() }));
  } catch {}
  // Sent here by the chooser for a path of the site (?next=): the link opens that path.
  const next = nextPath();
  const open = document.getElementById("open") as HTMLAnchorElement | null;
  if (open && next) {
    open.setAttribute("href", next);
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
      location.assign(rebuildURL());
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
document.getElementById("rebuild")?.setAttribute("href", rebuildURL());

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
  finishProgress(false);
  // A failed build may come from what the cache holds: its clean-up stays available.
  if (USE_STORE && cacheEl && !cacheEl.hidden) void showPackageCache(false);
  say(`Failed: ${e?.message ?? e}`);
  log(String(e?.stack ?? e));
});
