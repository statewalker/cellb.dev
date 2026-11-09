// The platform as a static site that runs it in a browser tab on cellb (dist/browser/):
//
//   /index.html                sends a first visit to the host page
//   /cellb-sw.js               the ServiceWorker: the rest of the origin is the platform
//   /__cellb/                  the host page, its script and the shard worker, sqlite3.wasm
//   /__cellb/app/              the platform built for a browser realm by `cellb build`
//
// Run after `npm run build` (dist/platform/cellb). Serve dist/browser with any file server.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { buildProject } from "@statewalker/cellb/node";
import * as esbuild from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "dist/browser");
const require = createRequire(join(root, "package.json"));
mkdirSync(join(out, "__cellb"), { recursive: true });

await buildProject(join(root, "dist/platform/cellb"), join(out, "__cellb/app"));
const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
};
await esbuild.build({
  ...common,
  entryPoints: [join(root, "browser/host.ts")],
  outfile: join(out, "__cellb/host.js"),
});
await esbuild.build({
  ...common,
  entryPoints: [join(root, "browser/shard-worker.ts")],
  outfile: join(out, "__cellb/shard-worker.js"),
});
await esbuild.build({
  ...common,
  entryPoints: [join(root, "browser/sw.ts")],
  outfile: join(out, "cellb-sw.js"),
});
cpSync(join(root, "browser/index.html"), join(out, "__cellb/index.html"));
const sqliteDir = dirname(require.resolve("@sqlite.org/sqlite-wasm/package.json"));
for (const f of ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
  for (const d of ["dist", "sqlite-wasm/jswasm"]) {
    try {
      cpSync(join(sqliteDir, d, f), join(out, "__cellb", f));
      break;
    } catch {}
  }
}
writeFileSync(
  join(out, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>webrun platform</title><meta http-equiv="refresh" content="0; url=/__cellb/">\n',
);
const size = readFileSync(join(out, "__cellb/app/worker.js")).length;
console.log(`dist/browser: platform worker ${(size / 1e6).toFixed(1)} MB for the browser realm`);
