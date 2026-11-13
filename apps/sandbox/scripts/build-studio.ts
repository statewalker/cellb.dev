// Builds the studio Worker (studio/) for CellB in a browser: `cellb build` into
// public/studio/ (wrangler.json, worker.js, cellb.json), which the runner loads by URL the first
// time the Agent tab sends something. Run before `astro dev` and `astro build`.
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProject } from "@statewalker/cellb/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const t0 = Date.now();
await buildProject(`${root}studio`, `${root}public/studio`);
const kb = Math.round(statSync(`${root}public/studio/worker.js`).size / 1024);
console.log(`studio: built public/studio/worker.js (${kb} KB) in ${Date.now() - t0} ms`);
