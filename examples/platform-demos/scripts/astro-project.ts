/**
 * An Astro app's build output (Astro's Cloudflare adapter: dist/server and dist/client) as an
 * input project for the platform's bundler:
 *
 *   /wrangler.json     the adapter's dist/server/wrangler.json, reduced to the keys a project
 *                      declares (main → server/entry.mjs, assets → client)
 *   /server/…          dist/server: the Worker entry and its chunks (wrangler would upload them
 *                      with no_bundle; the platform bundles them into one module)
 *   /client/…          dist/client: the static assets
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const KEEP = [
  "name",
  "compatibility_date",
  "compatibility_flags",
  "vars",
  "durable_objects",
  "migrations",
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "queues",
  "triggers",
  "worker_loaders",
  "workflows",
  "services",
  "ai",
];

function tree(dir: string, base = dir, out = new Map<string, Uint8Array>()) {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) tree(f, base, out);
    else out.set(`/${relative(base, f)}`, readFileSync(f));
  }
  return out;
}

const isEmpty = (v: unknown) =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) ||
  (typeof v === "object" &&
    v !== null &&
    "producers" in v &&
    (v as { producers: unknown[]; consumers: unknown[] }).producers.length === 0 &&
    (v as { consumers: unknown[] }).consumers.length === 0);

export function astroProject(
  appDir: string,
  extra: { vars?: Record<string, string> } = {},
): Map<string, Uint8Array> {
  const dist = join(appDir, "dist");
  if (!existsSync(join(dist, "server/wrangler.json")))
    throw new Error(`${dist}/server/wrangler.json is missing: build the app first`);
  const adapter = JSON.parse(readFileSync(join(dist, "server/wrangler.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const config: Record<string, unknown> = {};
  for (const k of KEEP) if (!isEmpty(adapter[k])) config[k] = adapter[k];
  config.main = `server/${adapter.main ?? "entry.mjs"}`;
  const assets = adapter.assets as { binding?: string } | undefined;
  config.assets = { ...(assets?.binding ? { binding: assets.binding } : {}), directory: "client" };
  if (extra.vars) config.vars = { ...(config.vars as object), ...extra.vars };

  const files = new Map<string, Uint8Array>();
  files.set("/wrangler.json", new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`));
  for (const [p, b] of tree(join(dist, "server")))
    if (p !== "/wrangler.json" && !p.endsWith(".map")) files.set(`/server${p}`, b);
  for (const [p, b] of tree(join(dist, "client")))
    if (!p.endsWith("/.assetsignore")) files.set(`/client${p}`, b);
  return files;
}
