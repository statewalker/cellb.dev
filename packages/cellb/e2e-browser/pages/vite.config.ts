import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";

/**
 * Directories the dev server may serve. pnpm keeps packages in the WORKSPACE root's
 * node_modules/.pnpm, reached through symlinks; when the app is copied elsewhere (the
 * mutation harness symlinks node_modules into a temp copy), that store lies outside the
 * copy and Vite would refuse sqlite3.wasm — shards would never start.
 */
function allowedRoots(): string[] {
  const roots = [searchForWorkspaceRoot(resolve(import.meta.dirname, "../.."))];
  let dir = realpathSync(resolve(import.meta.dirname, "../../node_modules"));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      roots.push(dir);
      break;
    }
    dir = dirname(dir);
  }
  return roots;
}

/**
 * The labs (labs/*.html: cellb's storage internals, measured) need SharedArrayBuffer, so their
 * pages and workers are cross-origin isolated; the other pages are not (opfs-sahpool needs no
 * isolation, and some of them load cross-origin resources).
 */
const isolatedLabs: Plugin = {
  name: "cellb-labs-isolation",
  configureServer(server) {
    // A lab's own files, and what its pages and workers load (SQLite's OPFS proxy worker, from
    // node_modules, is requested by a lab worker: it must be isolated too).
    const fromLab = (referer: string | undefined) => {
      try {
        return !!referer && new URL(referer).pathname.startsWith("/labs/");
      } catch {
        return false;
      }
    };
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith("/labs/") || fromLab(req.headers.referer)) {
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      }
      next();
    });
  },
};

/**
 * `cellb build` folders the tests write into public/built/ while the server runs, served from
 * disk on every request. Vite serves public/ from a file list its watcher keeps: until the
 * watcher has seen a new file (and sometimes never, under churn), a request for it falls through
 * to index.html (statewalker/cellb.dev#212).
 */
const builtFolders: Plugin = {
  name: "cellb-built-folders",
  configureServer(server) {
    const root = resolve(import.meta.dirname, "public/built");
    const types: Record<string, string> = {
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".html": "text/html",
      ".css": "text/css",
      ".wasm": "application/wasm",
      ".txt": "text/plain",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/built/")) return next();
      const path = decodeURIComponent(
        new URL(req.url, "http://x").pathname.slice("/built/".length),
      );
      const file = resolve(root, path);
      if (!file.startsWith(`${root}/`) || !existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404;
        return res.end("not found");
      }
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(readFileSync(file));
    });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [isolatedLabs, builtFolders],
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
      "@statewalker/webrun-bundler",
      "esbuild-wasm",
      "assert",
      "buffer",
      "events",
      "path-browserify",
      "util",
      "@statewalker/webrun-files",
      // The Worker Loader's CommonJS modules and import() routing parse loaded code with acorn.
      "acorn",
    ],
    entries: [
      "index.html",
      "sharded/index.html",
      "backup/index.html",
      "miniflare/index.html",
      "projects/index.html",
      "../../src/isolate/isolate-worker.ts",
      "changelog/index.html",
      "ltx/index.html",
      "host/index.html",
      "host/host-worker.ts",
      "ltx/ltx-worker.ts",
      "changelog/log-worker.ts",
      "site-projects/index.html",
      "site-projects/site-worker.ts",
      "projects/project-worker.ts",
      "entry/index.html",
      "peers/index.html",
      "entry/entry-worker.ts",
      "load-project/index.html",
      "load-project/load-worker.ts",
      "shards/index.html",
      "shards/shard-worker.ts",
      "tabs/index.html",
      "tabs/main.ts",
      "tabs/shard-worker.ts",
      "tabs/sw.ts",
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
    // The port: Vite's default (5173) for `pnpm browser:dev`; Playwright passes a free one.
    strictPort: true,
    // The spread probe's frames run on names under .test, mapped to this server by Chromium's
    // --host-resolver-rules (e2e-browser/probes/spread.probe.spec.ts).
    allowedHosts: [".test"],
    fs: { allow: allowedRoots() },
    // A local S3 (RustFS) reached from pages through the dev server: requests are signed for
    // the real endpoint (s3ObjectStore's signAs), the proxy forwards them unchanged. The
    // default is interop-env.sh's shared RustFS; test runs set RUSTFS_ENDPOINT to their own.
    proxy: {
      "/s3": {
        target: process.env.RUSTFS_ENDPOINT ?? "http://127.0.0.1:9200",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/s3/, ""),
      },
    },
  },
  preview: { strictPort: true },
  // No COOP/COEP but for /labs/ (isolatedLabs): opfs-sahpool works without SharedArrayBuffer.
});
