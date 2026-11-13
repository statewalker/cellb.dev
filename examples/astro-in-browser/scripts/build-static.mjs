// The host pages as static files, for any HTTP file server (dist/static/):
//
//   /index.html                 the first visit: forwards to /__cellb/start.html
//   /cellb-sw.js                the ServiceWorker: cross-origin isolation for /__cellb/, and the
//                               rest of the origin is the app the host page built
//   /__cellb/start.html         the chooser: a link to each host page (also where the
//                               ServiceWorker sends a visit when no tab runs the site)
//   /__cellb/index.html         builds the small Astro app (app/) and runs it
//   /__cellb/emdash.html        builds EmDash (../emdash) and runs it
//   /__cellb/<app>-src/         each app's sources: list.json and files/<path>
//
// Both host pages run their app at the origin's root, so one origin runs one of them at a time.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const vite = join(root, "node_modules/vite/bin/vite.js");
const run = (...args) =>
  execFileSync(process.execPath, [vite, ...args], { cwd: root, stdio: "inherit" });
run("build", "browser", "--config", "browser/vite.config.ts");
run("build", "--config", "browser/vite.sw.config.ts");

// The first visit, before the ServiceWorker controls the origin: the chooser, which lives
// under /__cellb/ (once the ServiceWorker runs, `/` is the site built here).
writeFileSync(
  join(root, "dist/static/index.html"),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=/__cellb/start.html">
<title>Astro, built in the browser, on CellB</title>
<p><a href="/__cellb/start.html">Astro, built in the browser, on CellB</a></p>
`,
);
console.log("dist/static: serve it with any HTTP file server");
