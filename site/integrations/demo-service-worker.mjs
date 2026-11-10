// Bundles the homepage demo's ServiceWorker (src/demo/counter/sw.ts) to the site's root:
// a ServiceWorker controls only pages under its own path, and the demo runs on "/". Vite would
// put it in /_astro/, so it is built here, with esbuild, in `astro dev` and `astro build`.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ENTRY = fileURLToPath(new URL("../src/demo/counter/sw.ts", import.meta.url));
export const DEMO_SW_PATH = "/cellb-demo-sw.js";

async function bundle() {
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife", // a classic ServiceWorker: module ones are not everywhere yet
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    // Code the router does not run reads it (worker URLs); in a classic worker it is the script.
    define: { "import.meta.url": "self.location.href" },
    logLevel: "warning",
  });
  return out.outputFiles[0].contents;
}

/** @returns {import("astro").AstroIntegration} */
export function demoServiceWorker() {
  return {
    name: "cellb-demo-service-worker",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(DEMO_SW_PATH, async (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(await bundle());
        });
      },
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL(`.${DEMO_SW_PATH}`, dir), await bundle());
      },
    },
  };
}
