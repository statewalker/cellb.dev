import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";

const apps = {
  app: resolve(import.meta.dirname, "../app"),
  emdash: resolve(import.meta.dirname, "../../emdash"),
};
const SKIP = new Set([
  "node_modules",
  "dist",
  ".astro",
  "test",
  "test-results",
  "screenshots",
  "browser",
  "scripts",
  ".emdash",
  "playwright-report",
]);
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    SKIP.has(n) || n.startsWith(".")
      ? []
      : statSync(join(d, n)).isDirectory()
        ? walk(join(d, n))
        : [join(d, n)],
  );

const listOf = (app: string) => walk(app).map((f) => `/${relative(app, f).split("\\").join("/")}`);

/**
 * The app's SOURCES as plain files (the browser builds them): list.json and files/<path>, served
 * by the dev server and written into the static build.
 */
function appSources(): Plugin {
  return {
    name: "app-sources",
    generateBundle() {
      for (const [name, app] of Object.entries(apps)) {
        const list = listOf(app);
        this.emitFile({
          type: "asset",
          fileName: `${name}-src/list.json`,
          source: JSON.stringify(list),
        });
        for (const p of list)
          this.emitFile({
            type: "asset",
            fileName: `${name}-src/files${p}`,
            source: readFileSync(join(app, p)),
          });
      }
    },
    configureServer(server) {
      for (const [name, app] of Object.entries(apps))
        server.middlewares.use(`/__cellb/${name}-src/`, (req, res, next) => {
          const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
          if (path === "/list.json") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(listOf(app)));
          }
          const file = join(app, path.replace(/^\/files/, ""));
          if (path.startsWith("/files/") && file.startsWith(app) && existsSync(file)) {
            res.setHeader("content-type", "application/octet-stream");
            return res.end(readFileSync(file));
          }
          next();
        });
    },
  };
}

// The host page and its workers under /__cellb/; the rest of the origin is the built site.
// No COOP/COEP here: the ServiceWorker adds them (browser/sw.ts).
export default defineConfig({
  root: import.meta.dirname,
  base: "/__cellb/",
  plugins: [appSources()],
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm", "esbuild-wasm"],
    entries: [
      "index.html",
      "emdash.html",
      "cells-lab.html",
      "host.ts",
      "shard-worker.ts",
      "sw.ts",
      "builder-worker.ts",
    ],
  },
  worker: { format: "es" },
  // A production build replaces `globalThis.process.env` with `{}`, which makes cellb's
  // `Object.assign(globalThis.process.env, vars)` in the shard worker a no-op: the built Worker
  // then reads no `vars` from process.env (EmDash: "Set siteUrl or EMDASH_SITE_URL").
  define: { "globalThis.process.env": "globalThis.process.env" },
  // `vite build`: the two host pages, their workers and the apps' sources under
  // dist/static/__cellb/ (the base); scripts/build-static.mjs adds the ServiceWorker.
  build: {
    outDir: resolve(import.meta.dirname, "../dist/static/__cellb"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        emdash: resolve(import.meta.dirname, "emdash.html"),
      },
    },
  },
  server: {
    strictPort: true,
    headers: { "Service-Worker-Allowed": "/" },
    // webrun-bundler is linked from a webrun-sites checkout (with its module-type fix).
    fs: {
      allow: [
        searchForWorkspaceRoot(resolve(import.meta.dirname, "..")),
        resolve(import.meta.dirname, "../../../../webrun-sites"),
      ],
    },
  },
});
