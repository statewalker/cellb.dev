// @ts-check
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { swWorker } from "./integrations/sw-worker.mjs";

export default defineConfig({
  integrations: [react(), swWorker()],
  vite: {
    plugins: [tailwindcss()],
    resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
    // The runner worker starts CellB: SQLite WASM finds its .wasm next to its own module, so it is
    // not pre-bundled; the worker is an ES module (it starts nested workers).
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm", "esbuild-wasm"] },
    worker: { format: "es" },
  },
});
