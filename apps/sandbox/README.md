# @statewalker/cellb-sandbox

> Private, not published. A demo of CellB, and the seed of a CodeSandbox-like tool.

## What it is

An Astro + shadcn/ui site that runs a full-stack web application from a folder on your computer,
in the browser tab, with nothing uploaded:

- **Server part:** `wrangler.jsonc` and its `main`, bundled by webrun-bundler on esbuild-wasm
  (`@statewalker/cellb/bundle`) and run by CellB (`loadProject` from `@statewalker/cellb/browser`),
  with Durable Objects on SQLite WASM in OPFS. npm packages come from the registry.
- **Client part:** an HTML page whose `<script src>` and `<link href>` name TS, TSX, JS, JSX or CSS
  files, compiled module by module by `@statewalker/webrun-modules` (npm imports included).
- **Both** form one site, hosted by the page's ServiceWorker (`siteHostOverPort` /
  `hostSitesForWorker` from `@statewalker/cellb/site`), shown in a preview frame and openable in any
  tab of the origin.
- **Download .zip** packs the folder's files (`zip` from `@statewalker/cellb-platform-core/util`).

## A project folder

```
wrangler.jsonc          the server: a Worker (Durable Objects, KV, D1…)
package.json            npm dependencies (client/package.json, if any, wins for the client)
server/index.ts         wrangler's "main"
client/index.html       the client: <script type="module" src="./src/main.tsx">
client/src/…            TS / TSX / JS / JSX / CSS
```

The client folder is wrangler.jsonc's optional `"client"` field, else `client/`, else `public/`,
else the root (a client-only folder). The client calls the server with **relative** URLs
(`fetch("api/tasks")`): the sandbox serves the app under its own path, and a deployment at the
root of its origin works the same way. Requests that match no client file go to the server.

`sample/tasks` is such a folder: a Hono server with a `TaskList` Durable Object, and a React TSX
client. "Try the sample" runs it; "Download the sample" gives it as a ZIP to open as a folder.

## Running it

```sh
pnpm install
pnpm --filter @statewalker/cellb-sandbox dev      # http://localhost:4321
pnpm --filter @statewalker/cellb-sandbox build
pnpm --filter @statewalker/cellb-sandbox test     # unit tests (Vitest)
pnpm --filter @statewalker/cellb-sandbox e2e      # after build: Chrome, via Playwright
```

`CHROME=/path/to/chrome` makes the e2e use an installed Chrome. Folder access with rerun on save
needs the File System Access API (Chrome, Edge); other browsers read the folder once
(`webkitdirectory`).

## How it works

| File | Role |
|---|---|
| `src/components/Sandbox.tsx` | The UI (React island): folder, file tree, Preview / Files / Log, ZIP |
| `src/sandbox/folder.ts` | Reading a folder: File System Access API, `webkitdirectory`, change polling |
| `src/sandbox/project.ts` | The folder's layout (server, client), HTML rewriting, MIME types |
| `src/sandbox/app-site.ts` | The app as one handler: client files, compiled modules (`/_modules/`), server |
| `src/sandbox/runner.worker.ts` | The runner (Dedicated Worker): CellB, esbuild-wasm, the hosted site |
| `integrations/sw-worker.mjs` | Serves webrun-http-browser's ServiceWorker at `/sw-worker.js` |

- The runner keeps one npm package store (server) and one module cache (client) for its life, so
  a rerun downloads nothing again. Each run drops only the project's own compiled modules from the
  cache, and serves them `no-store`.
- The Durable Objects' OPFS pool is named after the project: data survives reruns. If another tab
  holds it, the run gets a fresh pool.

## Limits, and where it goes next

- Inline `<script type="module">` blocks are not compiled (only `src` scripts).
- The server is re-bundled whole on each run (under a second for the sample); `siteCompiler`
  would recompile one module instead.
- Files are read-only here. Next steps toward a CodeSandbox: an editor writing back through
  the folder handle (or an OPFS copy), the server compiled per module, and "Deploy" pushing the
  `buildProject` output (`packages/bundler`) and the cells' state to a celld bucket.
