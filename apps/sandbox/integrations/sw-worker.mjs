// Serves webrun-http-browser's ServiceWorker runtime at <base>sw-worker.js (the page passes that URL
// to hostSitesForWorker). Its scope is the sandbox's base path, so it can mount the site the runner
// worker asks for (the running app: its client and its server) under its own path there, and it
// stays clear of other ServiceWorkers on the origin (cellb.dev's homepage demo has scope "/").
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SW_FILE = "sw-worker.js";
const source = () => readFile(require.resolve("@statewalker/webrun-http-browser/sw-worker"));

/** @returns {import("astro").AstroIntegration} */
export function swWorker() {
  return {
    name: "cellb-sandbox-sw-worker",
    hooks: {
      "astro:server:setup": ({ server }) => {
        const base = server.config.base.replace(/\/?$/, "/");
        server.middlewares.use(`${base}${SW_FILE}`, async (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(await source());
        });
      },
      "astro:build:done": async ({ dir }) => {
        await writeFile(new URL(`./${SW_FILE}`, dir), await source());
      },
    },
  };
}
