import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";

const dist = resolve(import.meta.dirname, "../dist");

/** All files of dist/client, by their URL path. */
function assetPaths(dir = join(dist, "client")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? assetPaths(full)
      : [`/${relative(join(dist, "client"), full).split("\\").join("/")}`];
  });
}

/**
 * The built app, for the host page: its wrangler.json (`/__cellb/app/config.json`), its browser
 * bundle (`/__cellb/app/worker.js`), the list of its static assets (`/__cellb/app/assets.json`)
 * and the assets themselves (`/__cellb/app/assets/<path>`).
 */
function builtApp(): Plugin {
  return {
    name: "emdash-built-app",
    configureServer(server) {
      server.middlewares.use("/__cellb/app/", (req, res, next) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
        const send = (file: string, type: string) => {
          if (!existsSync(file)) {
            res.statusCode = 404;
            return res.end(`${relative(dist, file)} is missing: run \`pnpm build:browser\``);
          }
          res.setHeader("content-type", type);
          res.setHeader("cache-control", "no-store");
          res.end(readFileSync(file));
        };
        if (path === "/config.json")
          return send(join(dist, "server/wrangler.json"), "application/json");
        if (path === "/worker.js") return send(join(dist, "browser/worker.js"), "text/javascript");
        if (path === "/assets.json") {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(assetPaths()));
        }
        if (path.startsWith("/assets/"))
          return send(
            join(dist, "client", path.slice("/assets".length)),
            "application/octet-stream",
          );
        next();
      });
    },
  };
}

// The host page, its ServiceWorker and the shard worker live under /__cellb/; everything else of
// the origin is the EmDash site, served by the ServiceWorker from cellb.
export default defineConfig({
  root: import.meta.dirname,
  base: "/__cellb/",
  plugins: [builtApp()],
  // sqlite-wasm must not be pre-bundled (it locates its .wasm next to its module).
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
    entries: ["index.html", "host.ts", "shard-worker.ts", "sw.ts"],
  },
  worker: { format: "es" },
  // `vite build`: the host page and its shard worker under dist/static/__cellb/ (the base);
  // scripts/build-static.mjs adds the ServiceWorker and the app's own files.
  build: {
    outDir: resolve(import.meta.dirname, "../dist/static/__cellb"),
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    strictPort: true,
    // The ServiceWorker's script is under /__cellb/, its scope is the whole origin.
    headers: { "Service-Worker-Allowed": "/" },
    fs: { allow: [searchForWorkspaceRoot(resolve(import.meta.dirname, ".."))] },
  },
});
