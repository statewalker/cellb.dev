import { resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// The page and worker of the browser test (test/browser). No Cloudflare plugin here: the app
// itself is bundled by bundleWorkerForBrowser and handed to the worker as a string.
export default defineConfig({
  root: import.meta.dirname,
  // sqlite-wasm must not be pre-bundled (it locates its .wasm next to its module).
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
    entries: ["index.html", "flue-worker.ts", "flue-shard-worker.ts"],
  },
  worker: { format: "es" },
  server: {
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(resolve(import.meta.dirname, ".."))] },
  },
});
