// Builds the studio Worker (studio/) for CellB in a browser: `cellb build` into
// public/studio/ (wrangler.json, worker.js, cellb.json), which the runner loads by URL the first
// time the Agent tab sends something. Run before `astro dev` and `astro build`.
//
// It also copies @wasmer/sdk's dist/ and pkg/ to public/wasmer-sdk/, unbundled: the SDK starts its
// own worker from a URL, and that worker imports its sibling files, which a bundler does not follow.
// The Wasmer engine (src/sandbox/wasmer.worker.ts) imports the SDK from there.
import { cpSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildProject } from "@statewalker/cellb/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const t0 = Date.now();
await buildProject(`${root}studio`, `${root}public/studio`);
const kb = Math.round(statSync(`${root}public/studio/worker.js`).size / 1024);
console.log(`studio: built public/studio/worker.js (${kb} KB) in ${Date.now() - t0} ms`);

// The package exports no package.json: its folder is two levels above its node entry (dist/node.js).
const sdk = createRequire(import.meta.url)
  .resolve("@wasmer/sdk/node")
  .replace(/dist\/node\.js$/, "");
rmSync(`${root}public/wasmer-sdk`, { recursive: true, force: true });
for (const dir of ["dist", "pkg"])
  cpSync(`${sdk}${dir}`, `${root}public/wasmer-sdk/${dir}`, {
    recursive: true,
    filter: (src) => !/\.(map|d\.ts)$/.test(src),
  });
console.log("studio: @wasmer/sdk copied to public/wasmer-sdk/");
