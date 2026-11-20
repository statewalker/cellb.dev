import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  root: `${import.meta.dirname}/pages`,
  publicDir: `${import.meta.dirname}/../e2e-public`,
  plugins: [
    {
      // SharedArrayBuffer (Wasmer's workers, the filesystem bridge) needs cross-origin isolation.
      name: "cross-origin-isolation",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          next();
        });
      },
    },
  ],
  server: { fs: { allow: [searchForWorkspaceRoot(import.meta.dirname)] } },
  worker: { format: "es" },
  optimizeDeps: {
    // Both find their .wasm and worker scripts next to their modules.
    exclude: ["@wasmer/sdk", "@statewalker/cellb", "@sqlite.org/sqlite-wasm"],
    include: ["assert", "buffer", "events", "path-browserify", "util", "acorn"].map(
      (d) => `@statewalker/cellb > ${d}`,
    ),
    entries: ["index.html", "engine-worker.ts", "cellb-worker.ts", "capacity-worker.ts"],
  },
});
