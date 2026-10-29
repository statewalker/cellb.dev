import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";

const app = resolve(import.meta.dirname, "../app");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    n === "node_modules"
      ? []
      : statSync(join(d, n)).isDirectory()
        ? walk(join(d, n))
        : [join(d, n)],
  );

/** The app's SOURCES as plain files (the browser builds them): list.json and files/<path>. */
function appSources(): Plugin {
  return {
    name: "app-sources",
    configureServer(server) {
      server.middlewares.use("/__cellb/app-src/", (req, res, next) => {
        const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
        if (path === "/list.json") {
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify(walk(app).map((f) => `/${relative(app, f).split("\\").join("/")}`)),
          );
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
    entries: ["index.html", "host.ts", "shard-worker.ts", "sw.ts", "builder-worker.ts"],
  },
  worker: { format: "es" },
  server: {
    strictPort: true,
    headers: { "Service-Worker-Allowed": "/" },
    fs: { allow: [searchForWorkspaceRoot(resolve(import.meta.dirname, ".."))] },
  },
});
