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
- **Agents**: the **Agent** tab runs a **Flue agent in a Durable Object on CellB**, in the tab
  (`studio/`): its file tools hold a Biscuit capability (rights: edit, plan or read-only, and a
  scope), every file operation is authorized by the token's Datalog, and its writes come back to
  the project (and to disk). Bring your own key: Claude, or any OpenAI-compatible endpoint such
  as a local model. Agents outside the page use the IDE's tools through `window.cellbSandbox`,
  WebMCP (`navigator.modelContext`, where the browser has it) and an MCP endpoint served by the
  page's ServiceWorker.
- **Ship**: a deployable folder (the server bundled by `buildProject`, the client compiled into
  `assets/`) that `wrangler deploy`, `celld` and cellb on Node run as is; push to / open from
  GitHub; a `deploy` branch with a workflow that deploys to Cloudflare.

The design, the roadmap (HTTPeers, real git, notebooks, Astro) and how it compares with
Replit, StackBlitz, Bolt and the others: [`docs/architecture.md`](docs/architecture.md),
[`docs/alternatives.md`](docs/alternatives.md).

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

An `AGENTS.md` at the root tells agents the project's layout and API; the Flue agent gets it in
its instructions.

`sample/tasks` is such a folder: a Hono server with a `TaskList` Durable Object, and a React TSX
client. "Try the sample" runs it; "Download the sample" gives it as a ZIP to open as a folder.
`templates/notebook-dashboard` is a Durable Object with a notebook as its dashboard.
`templates/agent-ui` is a screen an agent pilots: a JSON spec (json-render / A2UI shape) kept in
a Durable Object, rendered from a fixed catalog of components.

**Astro sites**: a folder with an `astro.config.*` is an Astro site (`templates/astro-site`:
`.astro` pages, an API route, a React island, a Durable Object). The runner builds it from its
sources with `@statewalker/cellb-astro-builder` (the config and its integrations evaluated, the
pages compiled by compiler-rs as WebAssembly, the bundles made by esbuild-wasm; no Vite, no Node:
about 8 s for the template), then runs Astro's Cloudflare output on CellB like any Worker. The
preview serves the site under a path of its own, so the pages' and modules' `/_astro/` references
are moved under it; links in pages should be relative. Ship builds the same output into the
deployable folder (`buildAny`). The compiler needs a shared WebAssembly memory, so the sandbox is
cross-origin isolated: its ServiceWorker (`integrations/sw-worker.mjs`, around webrun's runtime)
adds `COOP: same-origin` and `COEP: credentialless` to every response it gives the sandbox's pages,
and the very first visit reloads once through it.

## Running it

```sh
pnpm install
pnpm --filter @statewalker/cellb-sandbox dev      # http://localhost:4321
pnpm --filter @statewalker/cellb-sandbox build
pnpm --filter @statewalker/cellb-sandbox test     # unit tests (Vitest), then the studio on
                                                  # cellb in Node (test/studio-node.ts)
S3_ENDPOINT=http://127.0.0.1:9200 pnpm --filter @statewalker/cellb-sandbox test   # + an S3 store
S3_ENDPOINT=http://127.0.0.1:9200 pnpm --filter @statewalker/cellb-sandbox e2e    # + S3 in the browser
pnpm --filter @statewalker/cellb-sandbox e2e      # after build: Chrome, via Playwright
                                                  # (test/e2e.mjs, then test/e2e-agent.mjs)
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

Rerun on save works in every browser. Writing edits back to the folder, and rerunning when a
file changes on disk, need the File System Access API (Chrome, Edge); other browsers read the
folder once (`webkitdirectory`) and keep edits in the tab.

## Editing

- **The tree** folds (a folder's row, or "Collapse all"). New file and New folder go where the
  selection is. Each row can be renamed or moved (its path field, or drag it onto a folder) and
  deleted.
- **The Code tab** is CodeMirror 6. The language comes from the file's extension and is loaded
  when a file of that kind is first opened: TS, TSX, JS, JSX, JSON/JSONC, CSS, HTML/SVG,
  Markdown. Ctrl/Cmd+S or Save writes the file; unsaved files are marked in the tree.
- **Where saves go:** to the project's source, through the page's owner capability: a folder
  opened with the File System Access API is changed on disk (the first edit asks for write
  access), browser storage in OPFS, a bucket in S3. A template, the sample or a folder read once
  live in memory in the studio worker: Download .zip keeps the edits.
- With **Rerun on save**, every save, new file, move and delete reruns the app.
- Ctrl/Cmd+S saves the open file from anywhere on the page. With unsaved edits, opening another
  project asks first, and the browser asks before the tab closes.
- Edits run one at a time, each on the state the one before left; the watcher pauses while one
  runs. A move is the source's own (`FilesApi.move`: the whole entry, with what the view leaves
  out, such as `node_modules`); a case-only rename goes through a temporary name.

## Agents

### Files, capabilities, and who holds what

The project's files are a `@statewalker/webrun-files` **FilesApi** owned by one worker, the
**studio worker** (`src/sandbox/studio.worker.ts`), opened from a source (`src/sandbox/sources.ts`):

| Source | FilesApi | Opened by |
|---|---|---|
| a folder on disk | `BrowserFilesApi` over the picked handle | Open folder (File System Access API) |
| memory | `MemFilesApi` | a template, the sample, a `webkitdirectory` folder, a GitHub branch |
| browser storage | `BrowserFilesApi` over an OPFS directory | "Open from browser storage" |
| S3 (AWS, R2, MinIO, RustFS…) | `S3FilesApi` | "An S3 bucket" (the bucket must allow CORS from the sandbox's origin; checked against RustFS in Node and in Chromium) |
| composite | `CompositeFilesApi`: a root and sources mounted at paths | `{ kind: "composite", root, mounts }` |

Nobody else holds the files. Everyone reaches them through a **capability**, a Biscuit token
the studio's Workspace cell checks on every operation (mode, scope, revocations):

| Holder | Token | Through |
|---|---|---|
| the page (the project's owner, the Workspace's admin) | `yolo` on `/` | `CapFilesApi` over `TokenCap` (`POST /api/fs/:ws`), served over a MessagePort: every edit, the tree, the watcher |
| the runner (builds and runs the app, in its own worker) | `readonly` | one `readTree` call per run or build |
| the Flue agent (studio's Agent cell) | the mode chosen in the Agent tab, narrowed by its scope | an RPC stub of `FilteredFiles` |
| other agents' tools (`window.cellbSandbox`, WebMCP, MCP) | "Rights of other agents" in the Agent tab | `TokenCap` |

Agents' writes, other tabs' and the disk's are seen the same way: the studio's change notices
and a watcher comparing the tree's sizes and dates (one `readTree` call) refresh the view and
rerun the app. There is no copy to keep in step.

### The Flue agent (Agent tab)

`studio/` is an ordinary Worker project (`wrangler.jsonc`, `src/worker.ts`), the agents' side
of the IDE, built for CellB (`scripts/build-studio.ts` → `public/studio/`) and run by the studio
worker, in a realm of its own (the app's Worker code runs in the runner, never next to it):

| Cell | Does |
|---|---|
| `Workspace` (one per project) | holds the Biscuit root key and the sessions; hands out capabilities on the FilesApi the host provides (`cellbStudioHost.store(ws)`), as `FilteredFiles` RpcTargets or token calls; without a host (a server deployment), on its own SQLite (`SqlFilesApi`) |
| `Agent` (one per project's agent) | runs a Flue agent loop (pi-agent-core + Flue's `read`, `write`, `edit`, `grep`, `glob`, `bash` over a just-bash sandbox whose only file system is the capability) and keeps its conversation; reports progress while it runs |

The capability core (`studio/src/capfs/`: Authority, FsGate, policy, CapFs, CapFilesApi) is
vendored from `statewalker-sandbox/apps/flue-capfs-do`; `files-store.ts` gives its gate the store
it expects over any FilesApi, `token-cap.ts` is the token transport. A run, from the page
(`src/sandbox/agent/flue.ts`):

1. a **session token** for the chosen rights: `yolo` (edit), `plan` (read everything, write only
   under `/plans/`), `readonly`; narrowed by a **scope** (an attenuation block: one folder);
2. the **run**: the model (`llm`) and the person's key (`x-llm-token`) come with it
   (`LLM_FROM_REQUEST`); a deployment can name its own model (`LLM`, `LLM_API_KEY`) instead;
3. while it runs, the page polls its **progress**; its writes are the files' writes.

Beyond files, the agent has `run_app`, `read_logs` and `http_request`: host tools that go from
the studio worker to the page, which reads the latest files and runs its own tools. A denied
operation comes back to the model as `EACCES`.

**Scripts**: the agent's `run_script` tool runs JavaScript it writes in a Worker Loader isolate
(`studio/src/script-tool.ts`; a Dedicated Worker of its own in a browser) with no network
(`globalOutbound: null`) and one object to act on: `files` (`readText`, `writeText`, `list`,
`exists`, `remove`), an RpcTarget over the agent's capability, narrowed further by `scope` /
`read_only`. One isolate per run, 30 s at most. `TOOL_ISOLATES: "off"` turns it off where an
isolate could reach the host (cellb on Node runs isolates as worker threads).

**Python**: the agent's `python` tool runs Python 3 (Pyodide, from jsdelivr, in a Worker the
studio worker starts on first use; `src/sandbox/python.worker.ts`). The engine never holds the
capability: before the run, `studio/src/python-tool.ts` copies in the files the capability may
read (`readTree`, each one authorized; 5000 files / 16 MB at most); after it, each file the code
wrote or deleted goes back through the capability, authorized again. A write the rights refuse
(read-only, plan, outside the scope, `.cellb/`) is reported as `denied` and not applied. Packages
such as numpy or pandas are loaded from the code's imports. 120 s at most per run, after which
the engine is replaced. A host without a Python engine (cellb on Node, workerd) has no such tool.

**Budgets**: every run is metered against its session (the Agent tab's "Budget" fields: model
turns and tokens per session, empty for unlimited). The Workspace cell reserves a turn before each
model request and charges the tokens after it; a spent budget ends the run (`stopReason: "limit"`)
and refuses the next one before any model request. The tab shows what is left after each run.

**Delegation**: the agent's `delegate` tool hands a self-contained task to a sub-agent whose
capability is the agent's own narrowed by one more Biscuit block (`scope`: one folder,
`read_only`): a sub-agent can only ever have fewer rights. It runs the same loop and model,
reports its tool calls as `sub:<tool>`, and cannot delegate again.

### Other agents: the IDE's tools

| Ingress | For | Where |
|---|---|---|
| `window.cellbSandbox` | browser-driving agents and scripts: `.tools`, `.call(name, args)`, `.mcpUrl` | `src/sandbox/agent/bridge.ts` |
| WebMCP | agents built into the browser (`navigator.modelContext.registerTool`, feature-detected) | `src/sandbox/agent/bridge.ts` |
| MCP | MCP clients on the same origin: Streamable HTTP, stateless JSON, at `<origin>/<id>/mcp` | `src/sandbox/agent/mcp.ts` |

The tools (`src/sandbox/agent/tools.ts`): `project_info`, `list_files`, `read_file`, `search`,
`write_file`, `edit_file`, `make_folder`, `move_path`, `delete_path`, `run_app`, `stop_app`,
`read_logs`, `http_request`. They go through the page's own edit queue, so an agent's change
on a folder opened with the File System Access API reaches the disk, the tree and the editor.
Agent edits do not rerun the app on their own: the agent calls `run_app` when its change is
complete. The Worker's `console.*` output is in the log (`read_logs`).

Keys stay in the tab and are stored only with "Remember…". A folder opened read-only asks for
write access when you press Send (the browser asks only during a click).

## Notebooks

A `notebooks/` folder is a part of the project, next to the server and the client: Markdown
files whose fenced `js` blocks are reactive cells (Observable Notebook Kit: `display()`, `npm:`
imports, top-level `await`), or Notebook Kit `.html` documents, served at `notebooks/<name>.html`
(`src/sandbox/notebooks.ts`). Their cells call the project's Worker with relative URLs
(`fetch("../api/events")`), so a notebook is a dashboard over the app's Durable Objects, a note,
or a report an agent writes as a file.

- Built by `@statewalker/notebook-build` (linkedom as its DOM, in the runner) on the first visit
  of each run, served by `@statewalker/notebook-site`; npm modules from a webrun-modules server
  whose cache lives as long as the runner.
- A project may be notebooks and a server only (no client): the preview opens on `notebooks/`.
  `templates/notebook-dashboard` is one (an event log in a Durable Object, its dashboard).
- In the deployable build (Ship → Build), notebook-build's static mode writes the pages under
  `assets/notebooks/` and every module they reach (with the CSS, wasm and fonts their packages
  ship) under `assets/notebooks/_m/`: a static host serves them, the Worker answers their
  `fetch("../api/…")`. Built for a deployment at the origin's root.

## History

The Ship tab's **History** is a real git repository the sandbox keeps in the project's own files,
under `.cellb/history` (`src/sandbox/history.ts`, webrun-vcs: loose objects, refs, an index), so
it lives where the project lives: on disk for a folder, in OPFS or S3 for those. It never
touches a project's own `.git` (its branches stay yours) and writes no `.gitignore`: its ignores
are in `.cellb/history/info/exclude` (`.git`, `.cellb`, `node_modules`, build output), and the
project's `.gitignore` files are honored too.

- **Commit** everything, with a message; the list shows commits with **Restore** (a hard reset:
  files written back, files the commit lacks removed; ignored files untouched).
- **Checkpoints**: with the box ticked, every agent run starts with a commit ("Before the agent:
  …"), so undoing an agent is a Restore.
- **Pull and branches**: Pull fetches a remote branch and fast-forwards (or merges) it into the
  current branch, then the files follow (uncommitted changes refuse it); the Branch row lists the
  branches, switches (the files become the branch's) and makes new ones.
- **Push to a git remote**: the history goes to any git server over smart HTTP (webrun-vcs builds
  the pack in the tab; a token goes as HTTP Basic `x-access-token`). A browser needs CORS from the
  server: GitHub, GitLab and Codeberg send none, so push through **`git-proxy/`**, a small Worker
  (deploy it with `wrangler deploy`, or run it on celld or cellb) that forwards only git's smart
  HTTP requests to `ALLOWED_HOSTS` and adds CORS headers for `ALLOWED_ORIGINS`; the remote is then
  `https://<proxy>/github.com/<owner>/<repo>.git`. Checked against `git http-backend`: directly
  from Chromium, and through the proxy on cellb in Node (`git log` and `git fsck --strict` on the
  server).
- The page works on it through its owner capability; agents' and other tools' tokens carry one
  more Biscuit block (`NO_GIT`) that keeps `.cellb/` and `.git/` out of their reach.

## Ship

- **Build** (runner `build` message): `buildProject` (`@statewalker/cellb-bundler`) bundles the
  server into `worker.js` with a `no_bundle` `wrangler.json`; `src/sandbox/export.ts` exports the
  client from a site of the same sources — the pages and every module they reach, a module whose
  URL a static host would give a non-JavaScript type saved as `<path>.js` — into `assets/`.
  `serve.mjs` runs the folder on cellb in Node; `DEPLOY.md` lists the commands per host.
- **GitHub** (`src/sandbox/github.ts`): GitHub's git endpoints send no CORS headers, its REST API
  does, so a push is a snapshot through the Git Data API (blobs for changed files, a tree on the
  branch's tree with deletions, a commit, a fast-forward of the branch). Empty repositories and
  new branches work. "Open … here" loads a branch into the tab. A fine-grained token with
  Contents: read and write is enough (add Workflows to push the deploy workflow).
- **Build and push** commits the build to a `deploy` branch with `.github/workflows/deploy.yml`
  (`npx wrangler@4 deploy`, repository secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`).

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
| `src/components/AgentPanel.tsx` | The Agent tab: model, rights and scope, transcript, Stop |
| `studio/` | The studio Worker: Workspace and Agent cells, Flue agents on a capability file system |
| `src/sandbox/agent/flue.ts` | The page's side of the Flue agent: token, run, progress |
| `src/sandbox/studio.worker.ts` | The studio worker: the files (any FilesApi), the studio Worker on CellB |
| `src/sandbox/sources.ts` | The sources: folder, memory, OPFS, S3, composite |
| `src/sandbox/session.ts` | The page's capabilities on a project: owner, build, per mode |
| `src/components/ShipPanel.tsx` | The Ship tab: build, download, GitHub push/pull, deploy branch |
| `src/sandbox/agent/` | The IDE's tools, the MCP handler, the page bridge, the Flue client |
| `src/sandbox/deploy.ts`, `export.ts` | The deployable folder, the static client export |
| `src/sandbox/github.ts` | Push and pull through GitHub's Git Data API |
| `src/sandbox/templates.ts` | The templates (`sample/tasks`, `templates/*`) |
| `integrations/sw-worker.mjs` | Serves webrun-http-browser's ServiceWorker at `<base>sw-worker.js` |

- The runner keeps one npm package store (server) and one module cache (client) for its life, so
  a rerun downloads nothing again. Each run drops only the project's own compiled modules from the
  cache, and serves them `no-store`.
- The Durable Objects' OPFS pool is named after the project: data survives reruns. If another tab
  holds it, the run gets a fresh pool.

## Publish (HTTPeers)

The Ship tab's Publish section puts the tab in an HTTPeers mesh. Its hub is
[`../sandbox-hub`](../sandbox-hub), a separate local Node app that holds a reservation on
`relay.httpeers.net`. Members the hub invited reach the tab as their role allows: a viewer gets
the running app (`/app/`), an agent the IDE's tools read-only (`/mcp/read`), an editor the tools
that change the project (`/mcp/edit`). Each MCP mount runs on a capability of its own, and
neither reaches the history.

```sh
pnpm --filter @statewalker/cellb-sandbox-hub start
```

Open the link it prints, then open a project.

```sh
pnpm --filter @statewalker/cellb-sandbox-hub invite editor
```

On the invited machine:

```sh
pnpm --filter @statewalker/cellb-sandbox-hub bridge '<blob>'
```

The bridge serves `http://127.0.0.1:8790/mcp`, which a desktop agent can use as its MCP server.
`pnpm e2e:mesh` tests all of it on the public relay.

## Limits, and where it goes next

- Inline `<script type="module">` blocks are not compiled (only `src` scripts).
- The server is re-bundled whole on each run (under a second for the sample); `siteCompiler`
  would recompile one module instead.
- The editor has no type checking or cross-file completion (no TypeScript language service).
- The Durable Objects' state does not travel with a build.
- Astro: root-absolute links in pages (`href="/posts/x"`) leave the preview's path (the deployed
  site is fine); Safari, without `COEP: credentialless`, cannot build Astro in the tab.
- Next steps (see `docs/architecture.md` §10): the server compiled per module, a FilesApi over the
  folder with webrun-vcs history, an anonymous public gateway for published apps, cell state promoted to a celld bucket.
