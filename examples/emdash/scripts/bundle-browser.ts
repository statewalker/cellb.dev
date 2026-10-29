// Bundles the Worker that `astro build` emitted (dist/server) for a browser realm: one ES module,
// written to dist/browser/worker.js, that the host page hands to its shard worker.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleWorkerForBrowser } from "@statewalker/cellb/node";

const dist = join(import.meta.dirname, "../dist");
const config = JSON.parse(readFileSync(join(dist, "server/wrangler.json"), "utf8"));
const bundle = await bundleWorkerForBrowser(join(dist, "server", config.main), {
  nodeCompat: true,
});
mkdirSync(join(dist, "browser"), { recursive: true });
writeFileSync(join(dist, "browser/worker.js"), bundle);
console.log(`dist/browser/worker.js: ${(bundle.length / 1e6).toFixed(1)} MB`);
