// @ts-check
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { swWorker } from "./integrations/sw-worker.mjs";

// The path the sandbox is served under: "/" on its own (`pnpm dev`), "/sandbox/app/" on cellb.dev
// (the site's build sets SANDBOX_BASE and copies dist/ there). Its ServiceWorker sits at that path,
// so its scope is the sandbox alone, not the site's root and its homepage demo.
const base = process.env.SANDBOX_BASE ?? "/";

export default defineConfig({
  base,
  trailingSlash: "ignore",
  integrations: [react(), swWorker()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        { find: "@", replacement: new URL("./src", import.meta.url).pathname },
        // The editor's language service needs TypeScript's JavaScript API: TypeScript 6, the last
        // compiler written in JavaScript (7 is native). Libraries importing "typescript" get it.
        { find: /^typescript$/, replacement: "typescript-js" },
      ],
    },
    // The runner worker starts CellB: SQLite WASM finds its .wasm next to its own module, so it is
    // not pre-bundled; the worker is an ES module (it starts nested workers).
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm", "esbuild-wasm"] },
    worker: { format: "es" },
  },
});
