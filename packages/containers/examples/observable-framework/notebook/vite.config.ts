// The notebook example: `vite --config examples/observable-framework/notebook/vite.config.ts`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const require = createRequire(import.meta.url);
// webrun-http-browser's ServiceWorker (it routes /nb/… to the page), served at the root so its
// scope covers the preview frame
const swWorker = require.resolve("@statewalker/webrun-http-browser/sw-worker");

export default defineConfig({
  root: import.meta.dirname,
  // a cache of its own: the e2e server (same package) runs beside it under Playwright, and two
  // servers optimizing into one cache directory break each other's dependencies
  cacheDir: `${import.meta.dirname}/../../../node_modules/.vite-notebook`,
  plugins: [
    {
      name: "notebook-host",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // SharedArrayBuffer (Lifo's synchronous mounts) needs cross-origin isolation;
          // credentialless lets the notebook load its fonts
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          if (req.url === "/sw-worker.js") {
            res.setHeader("Content-Type", "text/javascript");
            res.end(readFileSync(swWorker));
            return;
          }
          next();
        });
      },
    },
  ],
  // No HMR client: Lifo takes its worker's console output as the running command's output.
  server: { hmr: false, fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] } },
  worker: { format: "es" },
  optimizeDeps: { entries: ["index.html", "build-worker.ts", "run-worker.ts"] },
});
