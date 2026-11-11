# CellB sandbox

> `@statewalker/cellb-sandbox` — private, not published. A demo of CellB, and the seed of a
> CodeSandbox-like tool. Live at **https://cellb.dev/sandbox/app/**; about it:
> **https://cellb.dev/sandbox/** (`site/src/pages/sandbox.astro`).

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

`CHROME=/path/to/chrome` makes the e2e use an installed Chrome. `SANDBOX_BASE` sets the path the
build is served under (default `/`); the e2e serves `dist/` under that same path.

### On cellb.dev

The site's build (`pnpm --filter @statewalker/cellb-site build`) runs
`site/scripts/build-sandbox.mjs`: this package is built with `SANDBOX_BASE=/sandbox/app/` and
copied to `site/dist/sandbox/app/`. The ServiceWorker is served next to the page
(`<base>sw-worker.js`), so its scope is `/sandbox/app/` and it never meets the homepage demo's
worker (scope `/`). The site's workflow (`.github/workflows/site.yml`) runs the unit tests and the
e2e on that build:

```sh
SANDBOX_BASE=/sandbox/app/ pnpm --filter @statewalker/cellb-sandbox build
SANDBOX_BASE=/sandbox/app/ pnpm --filter @statewalker/cellb-sandbox e2e
```

Folder access with rerun on save, and saving edits back to the folder, needs the File System
Access API (Chrome, Edge); other browsers read the folder once (`webkitdirectory`) and keep edits
in the tab.

## Editing

- **The tree** folds (a folder's row, or "Collapse all"). New file and New folder go where the
  selection is. Each row can be renamed or moved (its path field, or drag it onto a folder) and
  deleted.
- **The Code tab** is CodeMirror 6. The language comes from the file's extension and is loaded
  when a file of that kind is first opened: TS, TSX, JS, JSX, JSON/JSONC, CSS, HTML/SVG,
  Markdown. Ctrl/Cmd+S or Save writes the file; unsaved files are marked in the tree.
- **Where saves go:** a folder opened with the File System Access API is changed on disk (the
  first edit asks for write access). The sample, or a folder read once, is changed in the tab
  only: Download .zip keeps the edits.
- With **Rerun on save**, every save, new file, move and delete reruns the app.
- Ctrl/Cmd+S saves the open file from anywhere on the page. With unsaved edits, opening another
  project asks first, and the browser asks before the tab closes.
- Edits run one at a time, each on the state the one before left; the folder watcher pauses
  while one runs. A move on disk uses the browser's `move()` where it has one, else copies the
  entry from disk (with what the sandbox skips, such as `node_modules`) and removes it; a
  case-only rename goes through a temporary name.

## How it works

| File | Role |
|---|---|
| `src/components/Sandbox.tsx` | The UI (React island): folder, Preview / Code / Log, edits, ZIP |
| `src/components/FileTree.tsx` | The file tree: folding, new file or folder, rename/move, delete, drag |
| `src/components/CodeEditor.tsx` | CodeMirror 6, with a language per file extension |
| `src/sandbox/workspace.ts` | Edits as pure functions over the files (add, write, move, remove) |
| `src/sandbox/folder.ts` | The folder: File System Access API, `webkitdirectory`, polling, writes |
| `src/sandbox/project.ts` | The folder's layout (server, client), HTML rewriting, MIME types |
| `src/sandbox/app-site.ts` | The app as one handler: client files, compiled modules (`/_modules/`), server |
| `src/sandbox/runner.worker.ts` | The runner (Dedicated Worker): CellB, esbuild-wasm, the hosted site |
| `integrations/sw-worker.mjs` | Serves webrun-http-browser's ServiceWorker at `<base>sw-worker.js` |

- The runner keeps one npm package store (server) and one module cache (client) for its life, so
  a rerun downloads nothing again. Each run drops only the project's own compiled modules from the
  cache, and serves them `no-store`.
- The Durable Objects' OPFS pool is named after the project: data survives reruns. If another tab
  holds it, the run gets a fresh pool.

## Limits, and where it goes next

- Inline `<script type="module">` blocks are not compiled (only `src` scripts).
- The server is re-bundled whole on each run (under a second for the sample); `siteCompiler`
  would recompile one module instead.
- The editor has no type checking or cross-file completion (no TypeScript language service).
- Next steps toward a CodeSandbox: the server compiled per module, edits kept in an OPFS copy
  between visits, and "Deploy" pushing the `buildProject` output (`packages/bundler`) and the
  cells' state to a celld bucket.
