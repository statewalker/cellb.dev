# CellB sandbox: a local-first coding platform for people and agents

> Status: design + first implementation (this package). What exists today is marked **[built]**,
> what is designed but not built yet **[next]**. The market comparison this design starts from is
> in [`alternatives.md`](alternatives.md).

## 1. The idea in one paragraph

Open a folder on your disk in a browser tab. Its full-stack app — a Workers-style server with
Durable Objects, and an HTML/TS client — compiles and runs **in the tab**, with real durable
state (SQLite in OPFS), nothing installed and nothing uploaded. People edit it with a light IDE;
agents edit it with the **same operations as tools** (in the tab, over WebMCP, over MCP). When it
works, the code goes to **git** and the **same build** runs on any host of the isomorphic
runtime: CellB in another browser (served to others over **HTTPeers**), **celld** (a server fleet
on one bucket), **cellb on Node**, or **Cloudflare** Durable Objects.

```
 local folder (FSA)                    the tab                                   hosts
 ┌────────────────┐   read/write   ┌──────────────────────────────────┐   build  ┌──────────────────────┐
 │ wrangler.jsonc │ ─────────────▶ │ IDE (Astro + React island)       │ ───────▶ │ Cloudflare (wrangler)│
 │ server/*.ts    │ ◀───────────── │  ├ tools  ◀── window / WebMCP    │          │ celld (bucket fleet) │
 │ client/*       │                │  │        ◀── window.cellbSandbox│   git    │ cellb on Node        │
 │ AGENTS.md      │                │  │        ◀── MCP                │ ───────▶ │ CellB in a tab,      │
 └────────────────┘                │  └ runner worker                 │          │   over HTTPeers      │
                                   │     ├ CellB: app Worker + DOs    │          └──────────────────────┘
                                   │     ├ CellB: studio Worker       │
                                   │     │   Workspace (capabilities) │
                                   │     │   Agent (Flue loop)        │
                                   │     └ webrun-modules: client     │
                                   │  ServiceWorker: preview, /mcp    │
                                   └──────────────────────────────────┘
```

## 2. Where it stands among the alternatives

From [`alternatives.md`](alternatives.md) §4, the gaps this design is built for:

- **Nobody runs the user's real local folder in the tab.** vscode.dev opens local folders but
  cannot run them; StackBlitz/WebContainers run code on a virtual FS; Dyad is local but a
  desktop install. → FSA folder + in-tab runtime **[built]**.
- **No in-browser runtime has durable server state.** WebContainers emulate Node and hand state
  to Supabase/Neon/Firebase. → Durable Objects with SQLite in OPFS, same storage format as celld
  **[built]**.
- **Dev ≠ prod everywhere else.** → One Workers-shaped project, one build, four hosts, checked by
  celld conformance (cellb's own suite) **[built]** (deploy folder, see §6).
- **External-agent interfaces are narrow and vendor-cloud-bound** (Replit MCP beta, v0 Platform
  API). → The workspace itself is the tool surface, locally, over MCP/WebMCP **[built]**.
- **Openness**: WebContainers need a commercial license; Daytona closed its source. → MIT, all
  layers.

Risks taken knowingly: Chromium-only folder access (others read a folder once), JS/TS/WASM only,
browser memory limits, and Cloudflare shipping its own in-browser playground with DOs.

## 3. Layers and the packages they reuse

| Layer | What | Package(s) | State |
|---|---|---|---|
| Files | the picked folder (FSA), writes back, watching | `src/sandbox/folder.ts`; later `@statewalker/webrun-files-browser` (`BrowserFilesApi`) so git, bundlers and agents share one FilesApi | [built] / [next] |
| Server runtime | `wrangler.jsonc` + `main` bundled by esbuild-wasm, run by CellB; DOs on SQLite WASM in OPFS | `@statewalker/cellb/browser` (`loadProject`), `@statewalker/cellb/bundle`, `@statewalker/webrun-bundler` | [built] |
| Client | HTML + TS/TSX/CSS compiled per module, npm from the registry | `@statewalker/webrun-modules` (`newModuleServer`) | [built] |
| Hosting in the tab | one site per run, served by the page's ServiceWorker | `@statewalker/cellb/site`, `webrun-site-host`, `webrun-http-browser` | [built] |
| Agent tools | 13 tools over the workspace + runner | `src/sandbox/agent/tools.ts` | [built] |
| Files | one FilesApi per project (folder, memory, OPFS, S3, composite), owned by the studio worker; everyone else holds capabilities | `src/sandbox/studio.worker.ts`, `sources.ts`, `session.ts`, `studio/src/capfs/files-store.ts`, `token-cap.ts` | [built] |
| Agents | Flue agents in Durable Objects on CellB, tools over a Biscuit-capability FilesApi | `studio/` (capability core vendored from `statewalker-sandbox/apps/flue-capfs-do`), `@flue/runtime`, `@earendil-works/pi-agent-core`, `just-bash`, `@statewalker/webrun-biscuit` | [built] |
| Agent ingress for other agents | `window.cellbSandbox`, WebMCP, MCP endpoint | `agent/bridge.ts`, `agent/mcp.ts` | [built] |
| Ship | deployable folder, GitHub push/pull, CI deploy workflow | `deploy.ts`, `export.ts`, `github.ts`, `@statewalker/cellb-bundler` (`buildProject`) | [built] |
| Remote reach | the running app and the tools for people/agents outside this browser | `@statewalker/httpeers-member` (`createSession`, `createMounts`), `httpeers-access` (Biscuit) | [next] |
| History | git in `.cellb/history` inside the project's FilesApi: commit, log, changes, restore, checkpoints before agent runs; hidden from agents (`NO_GIT`) | `src/sandbox/history.ts`, `@statewalker/vcs-commands`, `vcs-store-files`, `vcs-working-tree` | [built] |
| Git remotes | push of that history over smart HTTP; `git-proxy/` (a Worker) adds CORS for GitHub & co | `history.ts` (`push`), `git-proxy/`, `@statewalker/vcs-commands` | [built], with pull (fetch + merge) and branches |
| Notebooks | `notebooks/*.md` (Observable Notebook Kit cells) served at `notebooks/`, next to the app, cells calling its Worker | `src/sandbox/notebooks.ts`, `@statewalker/notebook-build`, `notebook-site`, linkedom | [built], in the deployable build too (static mode) |
| Astro | Astro sites built in the tab | `@statewalker/cellb-astro-builder` (needs cross-origin isolation: COOP/COEP from the SW) | [next] |

## 4. The project format (no proprietary format)

A project is a plain folder that `wrangler dev` also understands:

```
wrangler.jsonc        server: main, durable_objects, kv/d1/r2/queues/workflows bindings
package.json          npm versions (client/package.json wins for the client)
server/index.ts       wrangler's main
client/index.html     client: <script src="./src/main.tsx">
AGENTS.md             instructions for agents: layout, API, how to check a change
```

Conventions that make it portable: the client calls the server with **relative URLs**; requests
that match no client file go to the Worker (the same rule as Cloudflare's assets). The
`"client"` field in `wrangler.jsonc` is the sandbox's only extension and is dropped from builds.

## 5. Agent-native from the start

### 5.1 One tool surface

Every UI action has a tool, and the tools call the same code path as the buttons (`StudioHost`
in `Sandbox.tsx`): an agent edit on an opened folder is written to disk, shows in the tree and
the editor, and is undoable with git like any edit.

| Tool | Does | Read-only |
|---|---|---|
| `project_info` | name, on-disk or not, run state, layout conventions | ✓ |
| `list_files` (glob), `read_file` (line ranges), `search` (regex) | read the project | ✓ |
| `write_file`, `edit_file` (unique old→new, or `replace_all`), `make_folder`, `move_path`, `delete_path` | change it | |
| `run_app` | build + start, wait, return the run's log lines (bundling errors included) | |
| `stop_app`, `read_logs` (incremental, `errors_only`) | run control; the Worker's `console.*` is in the log | `read_logs` ✓ |
| `http_request` | call the running app as its client does | ✓ |

Design rules: JSON in/out, capped outputs that say when they cut, errors as text a model can
act on ("old_text occurs 2 times: make it unique"), paths confined to the project.

### 5.2 Four ingresses, one handler

| Who | How | Where |
|---|---|---|
| A person with a model key | **Agent tab**: a **Flue agent** in the studio's Agent cell (Claude through pi-ai's Anthropic API, or any OpenAI-compatible endpoint: Ollama, LM Studio, LiteLLM, OpenRouter, httpeers' `llm` service), its file tools on a capability | `studio/`, `agent/flue.ts` (§5.3) |
| Browser-driving agents (Playwright, extensions, computer use) | `window.cellbSandbox.call(name, args)`, `.tools` | `agent/bridge.ts` |
| Agents built into the browser | **WebMCP** `navigator.modelContext.registerTool` (feature-detected) | `agent/bridge.ts` |
| Any MCP client that can reach the origin | **MCP** Streamable HTTP (stateless JSON) at `<origin>/<id>/mcp`, served by the page's ServiceWorker | `agent/mcp.ts` |
| Agents elsewhere (desktop Claude Code, a CI agent, a teammate's agent) | the same MCP handler as an **HTTPeers mount**, Biscuit-guarded **[next]** | §7 |

`AGENTS.md` at the project's root goes into the Flue agent's instructions and is the first thing
the tools point external agents to. Templates ship one.

### 5.3 Flue agents on a capability file system [built]

The in-tab agent is not a loop in the page: it is a **Flue agent in a Durable Object**, in the
studio Worker (`studio/`), which the **studio worker** runs on CellB, in a realm of its own. The
design is `statewalker-sandbox/apps/flue-capfs-do`'s, whose capability core it vendors; the gate
works on **any FilesApi** the host provides, so capabilities filter the real files:

```
 studio worker (owns the files)                          page        runner        other agents
 ──────────────────────────────────────────────────      ─────       ──────        ────────────
 source FilesApi: folder · memory · OPFS · S3 · composite
   └ FilesStore (POSIX-like surface for the gate)
 Workspace  Authority: root key, sessions, modes, revocations
            FsGate: Datalog per entry (recursive ops too)
   ├ FilteredFiles RpcTarget ──▶ Agent: Flue loop (read/write/edit/grep/glob/bash → just-bash
   │                                    → CapFs → capability) + host tools (run_app…)
   └ POST /api/fs/:ws {token, req}  ◀── TokenCap ── owner token  readonly    their own mode
                                        (MessagePort)  (edits)     (builds)    (window, MCP)
 change notices ──────────────────────────────────▶ page watcher: refresh, rerun
```

- **Rights are a token, not a flag**: the session's authority block holds `right("/")` facts,
  the mode (`yolo`, `plan`: writes only under `/plans/`, `readonly`) is a policy the Workspace
  applies, a **scope** is an attenuation block (`check if resource($p), $p.starts_with("/client/")`)
  that can only narrow, offline. Every entry an operation touches is authorized (recursive
  `rm`, `cp`, `mv` included); `ls /` shows only what the token may list.
- **Two transports, one gate**: cells of the studio's runtime get an RPC stub; any other worker,
  tab or node gets the token and sends calls as JSON (`POST /api/fs/:ws`, bytes as `$b64`). A
  token can be stored and attenuated without the key.
- **Nobody else holds the files**: the page edits, the runner builds and the agents work through
  tokens; the app's Worker code (in the runner) never shares a realm with the files or the
  studio.
- **Sources**: a picked folder (`BrowserFilesApi`), memory (`MemFilesApi`), OPFS, S3
  (`S3FilesApi`), a `CompositeFilesApi` of them; on a server, a directory (`NodeFilesApi`), R2/S3
  or the Workspace's own SQLite (`SqlFilesApi`, used when no host provides a store).
- **Checked**: `test/studio-node.ts` (cellb in Node, over memory, a directory on disk and a
  composite: the owner token's FilesApi writes the store itself, a Flue edit lands in it, a
  read-only write is refused, a scope hides the rest, a narrowed read-only token's `readTree`);
  `test/e2e.mjs` (Chromium: every edit of the IDE, on a template and on a picked folder, through
  the owner capability); `test/e2e-agent.mjs` (the Flue agent edits, runs and calls the app; a
  read-only run's write is refused; other agents' tools in read-only mode are refused; an OPFS
  project is opened, run and written through a capability). S3 is checked against a local
  RustFS when `S3_ENDPOINT` is set: in Node through the whole scenario, and in Chromium (a
  project opened from a bucket, run, written through a capability; the AWS SDK's XML parsing
  needs `DOMParser` and `Node` in the worker, which linkedom provides).

**Delegation [built]**: the agent's `delegate` tool runs a sub-agent on the agent's capability
narrowed by one Biscuit block (a scope, read-only), one level deep; `test/studio-node.ts`
checks that a sub-agent scoped to `/client` is refused a write in `/server` and may write in
`/client`.

**[next]**: untrusted tools in Worker
Loader isolates, Python (Pyodide) and Wasmer sandboxes on the same capability, and for remote agents the same tokens checked by `withAccess` on an HTTPeers mount.

## 6. From the tab to the hosts

**Deployable folder [built]** (`Ship → Build`, runner `build` message):

```
wrangler.json     the project's config, main: worker.js, no_bundle: true, assets.directory: assets
worker.js(.map)   buildProject (packages/bundler): one ES module, cloudflare:* and node:* external
assets/…          the client exported from a site of the same sources: pages + every module they
                  reach (renamed *.js where a static host would mistype them)
migrations/…      D1 migrations
serve.mjs         cellb on Node as an HTTP server over the folder
DEPLOY.md         wrangler deploy · celld dev . · node serve.mjs
```

The e2e builds the agent-ui template in Chromium, unpacks the ZIP, and checks that cellb on Node
answers the page, a compiled module and the Durable Object API.

**Git [built, snapshot model]**: GitHub's git endpoints have no CORS, its REST API does, so
`github.ts` pushes a snapshot as a commit through the Git Data API (blobs → tree → commit →
fast-forward ref; unchanged files cost nothing, files gone are deleted, empty repos and new
branches handled) and pulls a branch into the tab. **Real git [next]**: webrun-vcs gives
history/branches/merge over a FilesApi (a `.git` in the folder), push/fetch over smart HTTP —
through a small CORS proxy, which can itself be a cellb Worker, or peer-to-peer over HTTPeers
(`vcs-protos/23-git-httpeers`).

**CI deploy [built]**: `Build and push` commits the deployable folder to a `deploy` branch with
`.github/workflows/deploy.yml` (`npx wrangler@4 deploy`, secrets `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`). Sources stay on `main`.

**celld / cellb-node**: the same folder (`celld dev .`, `node serve.mjs`); Durable Object state
does not travel by default. **[next]**: move a cell's state with the code — cellb stores cells in
celld's format, so "promote" = upload the OPFS cell files to the celld bucket.

## 7. CellB over HTTPeers [next]

HTTPeers is a libp2p mesh where every service is a `fetch` handler; a tab can serve one. Both the
running app and the tool surface already are fetch handlers, so publishing is a mount:

```ts
import { createMounts } from "@statewalker/httpeers-core";
import { createSession } from "@statewalker/httpeers-member/browser";

const mounts = createMounts();
mounts.provide("/app", (req) => runningSite(req));        // the app the preview shows
mounts.provide("/mcp", createMcpHandler(tools, { readOnly: !owner }));
const session = createSession({
  key: "cellb-sandbox", mounts, rules: [
    'capability("app:read") <- role("member");',
    'capability("studio:tools") <- role("owner");',
  ],
  serviceWorkerUrl: "/sw.js", readDeploymentConfig: async () => null,
});
await session.start();                                     // then join with an invitation
```

Members open it with `openSession` + `pinnedPeer` on a `*.p.httpeers.net` origin (the
`apps/demos` session-frame pattern). Two pieces are missing upstream: an **anonymous public
gateway** (today every viewer is a mesh member) and an **MCP-over-mesh client bridge** for
desktop agents (a local `httpeers-share` bridge exposing the mesh MCP mount on `localhost`).

## 8. The client side: UIs agents can pilot

Two complementary forms:

1. **Code** — the agent writes TSX like a person does (the tasks template).
2. **Specs** — the screen is data: a flat JSON tree `{ root, elements: { id: { type, props,
   children } }, state }`, rendered by a **catalog** the app fixes. Unknown components are refused:
   the catalog is the security boundary between what an agent writes and the page. The
   `agent-ui` template **[built]** keeps the spec in a Durable Object (`PUT api/surfaces/:id`),
   renders it with a 9-component catalog, and posts clicks back as actions the agent reads.

The spec shape is deliberately the one of **json-render** (vercel-labs; used by
`@statewalker/render.view.react`, React/shadcn catalogs) and close to **A2UI** v0.9
(`createSurface` / `updateComponents` / `updateDataModel`; a build-free DOM renderer exists in
`statewalker-sandbox/apps/httpeers-shell-protos/lib`). **[next]**: a `@json-render/react`
template, and A2UI message streams for incremental updates.

**Astro** is the layout/pages layer **[next]**: Astro projects build in the tab with
`@statewalker/cellb-astro-builder` (the `examples/astro-in-browser` path; needs COOP/COEP from the
sandbox's ServiceWorker for the compiler's shared memory), deploy with the same folder.

## 9. Notebooks: literate programs by people and agents [built]

Observable-style notebooks — Markdown with fenced reactive `js` cells, `npm:` imports,
`display()` — as a project type, for notes, dashboards and agent reports:

- Build: `newNotebookBuild({ notebooks, output, cache, moduleServer, dom, mode: "hosted" })` +
  `newNotebookSite({ output, moduleServer })` as the site handler (packages/notebooks shows the
  wiring); `mode: "static"` exports a deployable static site.
- Agents write notebooks as plain files (`write_file` on `*.md`), so a report an agent produces is
  a runnable, versioned document, and a notebook cell can `fetch("api/…")` the project's own
  Worker: dashboards over the app's Durable Objects.

## 10. Roadmap

| Phase | Content |
|---|---|
| 1 (this change) | Flue agents in Durable Objects on CellB with a Biscuit-capability file system (studio Worker), IDE tools for other agents (window/WebMCP/MCP), console capture, deployable build, GitHub snapshot push/pull, CI deploy workflow, agent-ui template, AGENTS.md |
| 2 | per-module server compile (`siteCompiler`) for fast reruns; TypeScript language service in the editor |
| 3 | HTTPeers: publish the app and the MCP mount; Biscuit permission modes; desktop-agent bridge; promote cell state to celld |
| 4 | Astro project type; json-render/A2UI templates; agent screenshots of the preview as a tool |

## 11. Security notes

- Keys (model, GitHub) live in the tab; stored only when the person ticks "remember"; sent only to
  the provider's API (the model key reaches the studio's Agent cell with the run, never the
  tools or the model's context, and is redacted from errors).
- The studio's admin key in the browser build is public (`public/studio/wrangler.json`): in a
  tab the studio has no network ingress, only the page's runner reaches it. Deployed elsewhere,
  it is a secret.
- The preview runs on the sandbox's origin under its own path; apps from untrusted sources should
  move to a separate origin (the HTTPeers `*.p.httpeers.net` session origins are built for that).
- The MCP endpoint is reachable only by code on the same origin (it is served by the page's
  ServiceWorker); remote reach is an explicit, token-guarded mount.
