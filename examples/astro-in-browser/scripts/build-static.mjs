// The host pages as static files, for any HTTP file server (dist/static/):
//
//   /index.html                 the first visit: a link to each host page
//   /cellb-sw.js                the ServiceWorker: cross-origin isolation for /__cellb/, and the
//                               rest of the origin is the app the host page built
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

writeFileSync(
  join(root, "dist/static/index.html"),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Astro, built in the browser, on CellB</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }</style>
<h1>Astro, built in the browser, on CellB</h1>
<p>Each page reads an app's sources, builds them in this tab (esbuild and Astro's compiler as
WebAssembly, packages from the npm registry) and runs the result on CellB, served from the tab at
this origin's root. One app at a time: building the other replaces it.</p>
<ul>
  <li><a href="/__cellb/">A small Astro app</a> (a few seconds)</li>
  <li><a href="/__cellb/emdash.html">EmDash</a>, the Astro CMS (about two minutes the first time, a
  few hundred packages)</li>
</ul>
`,
);
console.log("dist/static: serve it with any HTTP file server");
