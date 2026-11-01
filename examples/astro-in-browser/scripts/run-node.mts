/**
 * Runs the EmDash Worker built by scripts/trace-build.mts (traces/emdash/worker.js and client/)
 * on cellb in NODE, with the template's bindings (D1, R2, KV): setup through EmDash's API, then
 * the public pages, the admin page and its client assets. The browser runs the same bundle.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const built = join(import.meta.dirname, "../traces/emdash");
if (!existsSync(join(built, "worker.js")))
  throw new Error("run `tsx scripts/trace-build.mts emdash` first");
const dir = join(import.meta.dirname, "../traces/emdash-node");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(join(built, "worker.js"), join(dir, "worker.js"));
cpSync(join(built, "client"), join(dir, "client"), { recursive: true });
const origin = "http://localhost:8787";
writeFileSync(
  join(dir, "wrangler.json"),
  JSON.stringify({
    name: "emdash",
    main: "worker.js",
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "DB", database_name: "emdash" }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "emdash-media" }],
    kv_namespaces: [{ binding: "SESSION" }],
    // The template's maintenance cron (its src/worker.ts exports scheduled()).
    triggers: { crons: ["* * * * *"] },
    vars: { EMDASH_SITE_URL: origin },
    assets: { directory: "client", binding: "ASSETS" },
  }),
);
const t0 = performance.now();
// A clock a second before the next minute: the cron fires once the setup below is done.
const skew = 60_000 - (Date.now() % 60_000) - 1_000 - 25_000;
const clock = {
  now: () => Date.now() + skew,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const opener = nodeSqliteOpener();
let cronDb: ReturnType<typeof opener> | undefined;
const scheduledLogs: string[] = [];
for (const level of ["log", "warn", "error"] as const) {
  const real = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (String(args[0]).includes("[scheduled]")) scheduledLogs.push(args.map(String).join(" "));
    real(...args);
  };
}
const { runtime, unsupported } = await loadNodeProject(dir, {
  openSql: Object.assign((key: string) => {
    const db = opener(key);
    if (key === "__cellb/cron") cronDb = db;
    return db;
  }, opener),
  files: new MemFilesApi(),
  clock,
});
console.log(
  `loaded in ${Math.round(performance.now() - t0)} ms; unsupported: ${JSON.stringify(unsupported)}`,
);
const req = (path: string, init?: RequestInit) =>
  runtime.fetch(new Request(`${origin}${path}`, { redirect: "manual", ...init }));
const show = async (path: string, init?: RequestInit) => {
  const t = performance.now();
  const r = await req(path, init);
  const body = await r.text();
  console.log(
    `${init?.method ?? "GET"} ${path} → ${r.status} ${r.headers.get("content-type") ?? ""} ${body.length} B in ${Math.round(performance.now() - t)} ms${r.status >= 300 && r.status < 400 ? ` → ${r.headers.get("location")}` : ""}${r.status >= 400 ? `: ${body.slice(0, 300)}` : ""}`,
  );
  return { r, body };
};
try {
  await show("/_emdash/api/setup/status");
  for (let i = 0; i < 20; i++) {
    const { body } = await show("/_emdash/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-emdash-request": "1", origin },
      body: JSON.stringify({
        title: "Built in the Browser, run on Node",
        tagline: "The same bundle",
        includeContent: true,
      }),
    });
    if (JSON.parse(body).data?.seedComplete) break;
  }
  const home = await show("/");
  console.log(
    `  home has the title: ${home.body.includes("Built in the Browser, run on Node")}, posts: ${(home.body.match(/href="\/posts\/[^"]+"/g) ?? []).length}`,
  );
  await show("/posts");
  await show("/posts/notes-on-simplicity");
  await show("/rss.xml");
  const admin = await show("/_emdash/admin/setup");
  const assets = [
    ...admin.body.matchAll(/(?:src|href|component-url|renderer-url)="(\/_astro\/[^"]+)"/g),
  ].map((m) => m[1]);
  for (const a of [...new Set(assets)].slice(0, 6)) await show(a);
  // The cron trigger: EmDash's scheduled() (publishing, maintenance) has run once.
  const due = 60_000 - (clock.now() % 60_000);
  await new Promise((r) => setTimeout(r, Math.min(due, 60_000) + 3_000));
  const runs = cronDb?.exec("SELECT expression, scheduled_time FROM cron_state", []).rows ?? [];
  console.log(
    `cron: ${runs.length ? runs.map(([e, t]) => `"${e}" ran for ${new Date(Number(t)).toISOString()}`).join(", ") : "never ran"}; scheduled() logged: ${JSON.stringify(scheduledLogs)}`,
  );
  if (!runs.length || scheduledLogs.some((l) => /failed/.test(l)))
    throw new Error("the cron trigger did not run EmDash's scheduled() cleanly");
} finally {
  await runtime.close();
}
