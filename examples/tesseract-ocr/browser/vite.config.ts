import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite";

const root = resolve(import.meta.dirname, "..");

/**
 * What the app fetches at runtime, from this server: the Tesseract models (`/models/<lang>
 * .traineddata`, from fixtures/models) and tesseract-core.wasm for Worker Loader isolates,
 * counted per file (`/__hits`) so the test can tell a model read from OPFS from a download.
 * `/app/wrangler.json` (written by `cellb build`) is served with the two vars pointing here.
 */
function ocrFiles(): Plugin {
  const hits: Record<string, number> = {};
  return {
    name: "ocr-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/__hits") {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(hits));
        }
        if (path === "/app/wrangler.json") {
          const config = JSON.parse(
            readFileSync(join(root, "browser/public/app/wrangler.json"), "utf8"),
          );
          const base = `http://${req.headers.host}/`;
          config.vars = {
            MODEL_BASE_URL: `${base}models/`,
            WASM_URL: `${base}tesseract-core.wasm`,
          };
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(config));
        }
        const model = path.match(/^\/models\/([\w-]+\.traineddata)$/);
        const file = model
          ? join(root, "fixtures/models", model[1])
          : path === "/tesseract-core.wasm"
            ? join(root, "node_modules/tesseract-wasm/dist/tesseract-core.wasm")
            : null;
        if (!file) return next();
        if (!existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        const name = path.split("/").pop() as string;
        hits[name] = (hits[name] ?? 0) + 1;
        res.setHeader("content-type", "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
  };
}

// The page and worker of the browser test (test/browser).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [ocrFiles()],
  // sqlite-wasm locates its .wasm next to its module, and cellb its isolate worker: neither is
  // pre-bundled. cellb's CommonJS dependencies (Node built-in polyfills) still must be.
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm", "@statewalker/cellb"],
    include: [
      "@statewalker/cellb > buffer",
      "@statewalker/cellb > events",
      "@statewalker/cellb > util",
      "@statewalker/cellb > assert",
      "@statewalker/cellb > path-browserify",
    ],
    entries: ["index.html", "app-worker.ts"],
  },
  worker: { format: "es" },
  server: {
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(root)] },
  },
});
