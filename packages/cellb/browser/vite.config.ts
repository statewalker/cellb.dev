import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";

/**
 * Directories the dev server may serve. pnpm keeps packages in the WORKSPACE root's
 * node_modules/.pnpm, reached through symlinks; when the app is copied elsewhere (the
 * mutation harness symlinks node_modules into a temp copy), that store lies outside the
 * copy and Vite would refuse sqlite3.wasm — shards would never start.
 */
function allowedRoots(): string[] {
  const roots = [searchForWorkspaceRoot(resolve(import.meta.dirname, ".."))];
  let dir = realpathSync(resolve(import.meta.dirname, "../node_modules"));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      roots.push(dir);
      break;
    }
    dir = dirname(dir);
  }
  return roots;
}

export default defineConfig({
  root: import.meta.dirname,
  // sqlite-wasm must not be pre-bundled (it locates its .wasm next to its module).
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm", "sqlite-vec-wasm-demo"],
    // Pre-bundle at startup: a dependency discovered late makes Vite reload the page mid-test.
    include: [
      "@statewalker/webrun-files-browser",
      "@statewalker/webrun-rpc",
      "@statewalker/webrun-http-streams",
      "@statewalker/webrun-modules",
      "@statewalker/webrun-files-mem",
      "@statewalker/webrun-site-host",
      "@statewalker/webrun-site-builder",
      "assert",
      "buffer",
      "events",
      "path-browserify",
      "util",
      "@statewalker/webrun-files",
    ],
    entries: [
      "index.html",
      "sharded/index.html",
      "backup/index.html",
      "miniflare/index.html",
      "projects/index.html",
      "isolate/isolate-worker.ts",
      "changelog/index.html",
      "ltx/index.html",
      "ltx/ltx-worker.ts",
      "changelog/log-worker.ts",
      "site-projects/index.html",
      "site-projects/site-worker.ts",
      "projects/project-worker.ts",
      "miniflare/mf-worker.ts",
      "cell-worker.ts",
      "sharded/shard-worker.ts",
      "backup/backup-worker.ts",
      "sharded/sw.ts",
      // NOT sharded/user/**: user sources import "cloudflare:workers", which only the
      // webrun-modules server resolves — in the scan it aborts all pre-bundling.
    ],
  },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: allowedRoots() },
    // A local S3 (RustFS) reached from pages through the dev server: requests are signed for
    // the real endpoint (s3ObjectStore's signAs), the proxy forwards them unchanged.
    proxy: {
      "/s3": {
        target: process.env.RUSTFS_ENDPOINT ?? "http://127.0.0.1:9200",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/s3/, ""),
      },
    },
  },
  preview: { port: 5173, strictPort: true },
  // No COOP/COEP needed: opfs-sahpool works without SharedArrayBuffer.
});
