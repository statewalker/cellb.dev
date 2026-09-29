import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  // sqlite-wasm must not be pre-bundled (it locates its .wasm next to its module).
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
    // Pre-bundle at startup: a dependency discovered late makes Vite reload the page mid-test.
    include: [
      "@statewalker/webrun-files-browser",
      "@statewalker/webrun-rpc",
      "@statewalker/webrun-http-streams",
      "@statewalker/webrun-modules",
      "@statewalker/webrun-files-mem",
      "@statewalker/webrun-files",
    ],
    entries: [
      "index.html",
      "sharded/index.html",
      "backup/index.html",
      "**/*worker*.ts",
      "sharded/sw.ts",
    ],
  },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
  // No COOP/COEP needed: opfs-sahpool works without SharedArrayBuffer.
});
