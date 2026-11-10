// Serves webrun-http-browser's ServiceWorker runtime at /sw-worker.js, the URL webrun-site-host
// registers by default. At the origin's root its scope is "/", so it can mount the site the
// runner worker asks for (the running app: its client and its server) under its own path.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SW_PATH = "/sw-worker.js";
const source = () => readFile(require.resolve("@statewalker/webrun-http-browser/sw-worker"));

/** @returns {import("astro").AstroIntegration} */
export function swWorker() {
  return {
    name: "cellb-sandbox-sw-worker",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use(SW_PATH, async (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Service-Worker-Allowed", "/");
          res.end(await source());
        });
      },
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL(`.${SW_PATH}`, dir), await source());
      },
    },
  };
}
