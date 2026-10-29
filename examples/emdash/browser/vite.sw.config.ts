import { resolve } from "node:path";
import { defineConfig } from "vite";

// The ServiceWorker of the static build: one self-contained ES module at the origin's root
// (dist/static/cellb-sw.js), written next to the host page's build (vite.config.ts).
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "../dist/static"),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "sw.ts"),
      formats: ["es"],
      fileName: () => "cellb-sw.js",
    },
    rollupOptions: { output: { codeSplitting: false } },
    minify: false,
  },
});
