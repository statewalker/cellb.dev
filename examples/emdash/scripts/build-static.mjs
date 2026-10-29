// The whole thing as static files, for any HTTP file server (dist/static/):
//
//   /index.html            sends the first visit to the host page
//   /cellb-sw.js           the ServiceWorker: the rest of the origin is the EmDash site
//   /__cellb/              the host page and its shard worker (vite build)
//   /__cellb/app/          the app: config.json (its wrangler.json), worker.js (its browser
//                          bundle), assets.json and assets/ (its static assets, dist/client)
//
// Run after `pnpm build:browser` (the astro build and the browser bundle).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const out = join(dist, "static");
for (const f of ["server/wrangler.json", "browser/worker.js", "client"])
  if (!existsSync(join(dist, f)))
    throw new Error(`dist/${f} is missing: run \`pnpm build:browser\``);

const vite = join(root, "node_modules/vite/bin/vite.js");
const run = (...args) =>
  execFileSync(process.execPath, [vite, ...args], { cwd: root, stdio: "inherit" });
run("build", "browser", "--config", "browser/vite.config.ts");
run("build", "--config", "browser/vite.sw.config.ts");

const app = join(out, "__cellb/app");
mkdirSync(app, { recursive: true });
cpSync(join(dist, "server/wrangler.json"), join(app, "config.json"));
cpSync(join(dist, "browser/worker.js"), join(app, "worker.js"));
cpSync(join(dist, "client"), join(app, "assets"), { recursive: true });
const walk = (dir) =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );
const paths = walk(join(app, "assets")).map(
  (f) => `/${relative(join(app, "assets"), f).split("\\").join("/")}`,
);
writeFileSync(join(app, "assets.json"), JSON.stringify(paths));
writeFileSync(
  join(out, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>EmDash on cellb</title>' +
    '<meta http-equiv="refresh" content="0; url=/__cellb/">' +
    '<p>Starting EmDash on cellb: <a href="/__cellb/">open the host page</a>.</p>\n',
);
console.log(`dist/static: ${paths.length} app assets; serve it with any HTTP file server`);
