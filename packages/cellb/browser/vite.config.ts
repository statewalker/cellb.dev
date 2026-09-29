import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  // sqlite-wasm must not be pre-bundled (it locates its .wasm next to its module).
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  // No COOP/COEP needed: opfs-sahpool works without SharedArrayBuffer.
});
