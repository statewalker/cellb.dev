# Alternatives: browser / cloud coding platforms vs. our concept

_Research date: 2026-11-11. Web research plus prior knowledge. Facts marked **(?)** are uncertain, come only from third-party sources, or could not be checked against a primary source. Pricing changes often; the one-line pricing notes show the model, not exact current prices._

**Our concept, for reference:** a light IDE that works on a **local folder through the File System Access API (FSA)**. It compiles and runs full-stack apps **inside the browser tab**. The server part runs as Cloudflare-Workers-compatible **Durable Objects** in the in-browser **CellB** runtime, and the client part is compiled module by module. The code then goes to a remote git repo and is deployed to the **same isomorphic runtime** on a server or on Cloudflare. The platform is **agent-native** from day one.

---

## 1. Status changes in 2025-2026 worth knowing

| Platform | Change |
|---|---|
| **Glitch** | Project hosting and user profiles ended on **2025-07-08**. Code download stayed open to the end of 2025. The product is effectively dead. |
| **Gitpod** | Renamed **Ona** (Sept 2025) and became an "agent mission control" product with environments. Gitpod Classic pay-as-you-go was **retired 2025-10-15**. `.gitpod.yml` was replaced by devcontainer.json plus automations.yml. |
| **Firebase Studio (ex Project IDX)** | Sunset announced **2026-03-19**. New workspaces and sign-ups disabled since **2026-06-22**. Full shutdown on **2027-03-22**. Google points users to **Google AI Studio Build mode** (uses the Antigravity agent harness) and **Google Antigravity**. |
| **CodeSandbox** | Acquired by **Together AI** (Dec 2024). The SDK went GA in May 2025 and is being rebranded **Together Code Sandbox**. CodeSandbox **Repositories/CI are deprecated**: no new imports since 2026-04-01, support ended 2026-07-01. Sandpack (Apache-2.0) is still available; recent activity looks low **(?)**. |
| **Daytona** | Went **closed source on 2026-06-11**. Last open release was v0.190.0 (AGPL). Reportedly archived Oct 2026 **(?)**. A community fork, "Nightona", exists. |
| **Cloudflare** | **Containers + Sandbox SDK went GA 2026-04-13**. **Dynamic Workers** (Worker Loader: load isolates with code generated at runtime, Durable Objects supported) entered open beta 2026-03-24. **VibeSDK** is an open-source AI app builder. |
| **Vercel** | **Vercel Sandbox GA 2026-01-30** (Firecracker microVMs). **New v0** (Feb 2026) imports git repos, works on a branch per chat, and runs in Vercel Sandbox. **v0 Platform API GA 2026-08-05**. |
| **Replit** | **Agent 4** (May 2026) adds parallel agents and effort-based pricing. Connectors, MCP servers and Git providers were merged into one Integrations page (June 2026). An official **Replit MCP server** is in beta. |
| **Bolt.new** | The v1 agent is being retired (no new projects after 2026-04-13, inaccessible after 2026-08-03) in favour of "Bolt v2" **(?, third-party)**. |
| **Deno Deploy** | The new Deploy (deno.net) has **Playgrounds** in the dashboard. **Deno Sandbox** (Linux microVMs, `@deno/sandbox`) was rolled out to Deploy users in Dec 2025 (pre-release). |
| **CodePen** | **CodePen 2.0** launched 2026-07-23. It adds multi-file Pens and a "Compiler" made of build "Blocks" (TS, Sass, Tailwind, Vue/Vite …). No AI at launch. |
| **marimo** | Acquired by **CoreWeave** (Oct 2025). Still open source (Apache-2.0). |
| **Observable** | **Notebooks 2.0**: open HTML-based file format, open-source Notebook Kit, and **Observable Desktop** (macOS, local files, git-friendly). |
| **Base44** | Acquired by **Wix** (June 2025, about $80M). Launched its own model "Base1" (mid-2026). |
| **Lovable** | Grew very fast (more than $600M ARR reported, $13.3B valuation Aug 2026). Added Lovable Cloud (managed backend) and mobile apps. |

---

## 2. Big comparison table

Legend: **Runs** = where user code executes. **Local** = works on files on the user's disk. **Offline** = usable with no network. **OSS** = open source / self-hostable.

| Platform | Runs (code execution) | Local disk / local-first | Offline | Git | Deploy target & lock-in | Backend / state model | AI agent support (built-in / external API·MCP) | OSS / self-host | Pricing (one phrase) | Key limitation |
|---|---|---|---|---|---|---|---|---|---|---|
| **Replit (+ Agent 4)** | Cloud container per Repl (Nix-based) | No (cloud workspace; desktop app is a thin client) | No | GitHub connector, git pane; import/export | Replit Deployments (autoscale, static, reserved VM). Medium-to-high lock-in (Replit DB/Postgres, Auth, Secrets, `.replit`/nix) | Built-in Postgres (Neon-backed **(?)**), KV "Replit DB", object storage | Strong built-in agent (Agent 4, parallel agents, plan mode). **Replit MCP server (beta)** lets external agents (e.g. Claude) create and manage apps. Connectors via MCP | No | Subscription + effort-based agent credits (Core ~$20/mo) | Cloud-only, unpredictable agent cost, hosting lock-in |
| **CodeSandbox (browser sandboxes / Sandpack)** | Browser bundler (Sandpack) for front-end; **Nodebox** = Node-compatible runtime in the browser (closed source **(?)**) | No (cloud-saved sandboxes) | Partial (Sandpack can be self-hosted/cached) | Limited now (Repositories product deprecated mid-2026) | Export only; no first-party hosting focus | None in browser mode | Some AI in editor **(?)**; Sandpack used as preview for third-party AI tools | Sandpack Apache-2.0; Nodebox not OSS **(?)** | Free tier + seats | Front-end-only in browser; product focus moved to SDK |
| **CodeSandbox SDK / Together Code Sandbox (VM sandboxes)** | Cloud **Firecracker microVMs** with snapshot/fork/hibernate | No | No | git inside VM | It is infrastructure, not a deploy target | Persistent VM disk, memory snapshots | API/SDK built for agents (code-interpreter use case) | No (SDK client OSS) | Usage-based (VM-hours) | Cloud dependency; transition to Together branding |
| **StackBlitz (WebContainers)** | **In-browser WASM "WebContainers"**: Node.js in the tab, in-memory FS, service-worker networking | No real local disk (virtual FS; GitHub import). Local sync **(?)**: none found | Partial (once loaded; npm needs network) | GitHub import/commit (StackBlitz Codeflow) | Netlify etc.; low lock-in for code | No server DB; only what runs in Node in-browser | Powers Bolt; WebContainer API used by third-party AI tools | WebContainer API proprietary (free for personal/OSS, **commercial license** required) | Free + paid seats; enterprise/API licenses | Chromium-first, no native binaries, no persistent backend state, proprietary runtime |
| **Bolt.new / bolt.diy** | Bolt: WebContainers in-browser (+ Bolt Cloud hosting **(?)**). bolt.diy: same, self-hosted UI | No (export/GitHub only) | No (LLM in cloud) | GitHub export/sync on paid plans | Netlify one-click (+ Bolt hosting **(?)**); Supabase for DB | Supabase integration (external) | Built-in prompt-to-app agent (Claude). bolt.diy: any LLM (incl. local Ollama) | bolt.diy MIT (but WebContainer API needs a commercial license for commercial use) | Token-based subscription (~$25/mo Pro) | Browser runtime has no real server state; token burn; v1 to v2 churn |
| **Lovable** | Cloud (builds and previews server-side) | No (two-way GitHub sync lets you edit locally) | No | **Two-way GitHub sync** (GitLab/Bitbucket on higher tiers **(?)**) | Lovable hosting / export React+Vite. Backend lock-in to Supabase / "Lovable Cloud" | Supabase Postgres, auth, storage, edge functions (Deno) | Strong built-in agent ("Build/Agent mode", plan mode). External API/MCP: limited **(?)** | No | Credit-based subscription (~$25 Pro, $50 Business) | Opinionated stack (React + Supabase); credit cost; cloud-only |
| **v0 (Vercel)** | Cloud **Vercel Sandbox** (Firecracker microVM) since the Feb 2026 rewrite | No (git import; edit locally via the repo) | No | **Git-native**: imports repos, a branch per chat, never writes to main | Vercel (high lock-in to Vercel platform features; Next.js-first) | Integrations via Vercel Marketplace (Neon, Supabase, Upstash…) | Built-in agent. **v0 Platform API GA (Aug 2026)**: prompt in, preview URL out, deploy call; usable by external agents | No | Credit-based subscription + usage | Next.js/Vercel-centric; cloud-only |
| **Firebase Studio (ex IDX)** — **sunsetting** | Cloud VMs (Code OSS + Nix) + Android emulators | No | No | Git in VM | Firebase App Hosting / Cloud Run | Firebase (Firestore, Auth) | Gemini agent + App Prototyping agent; MCP support | No | Free tier during preview | **Shutting down 2027-03-22**; replaced by AI Studio Build mode / Antigravity |
| **Google AI Studio Build mode** (successor) | Cloud preview; Node server-side runtime | No | No | Two-way GitHub sync | **Cloud Run** one-click; Firestore/Firebase Auth | Firestore | Antigravity-based agent | No | Free tier + Cloud Run usage | Google stack lock-in; app uses the owner's Gemini key |
| **GitHub Codespaces** | Cloud VM/container (devcontainer.json) | No (but works with desktop VS Code) | No | Native GitHub | Any (no deploy built in) | Whatever you run in the container | Copilot agent mode inside; Copilot cloud/coding agent uses similar Actions-based environments; MCP in VS Code | Devcontainer spec open; service closed | Per core-hour + storage (free quota) | Cost, cold starts, GitHub-only |
| **github.dev / vscode.dev** | **Browser only, no execution** (web extensions only; vscode.dev can use a remote tunnel) | **vscode.dev opens local folders via FSA** (Chromium) | Partial (editor only) | github.dev: GitHub repos via API (commit/branch) | None | None | Copilot Chat (limited in web) | VS Code core MIT; services closed | Free | **Cannot run code** without a remote/tunnel |
| **Ona (ex Gitpod)** | Cloud or customer-VPC environments (devcontainer) | No (desktop-IDE attach) | No | GitHub/GitLab/Bitbucket | None (dev envs only) | Container | **Agent-first**: Ona Agent, parallel background agents, guardrails; API/CLI | Gitpod Classic OSS (AGPL) archived; Ona proprietary | Usage-based (Core from ~$10-20/mo **(?)**) | Enterprise/agent focus; no app hosting |
| **Glitch** — **dead** | (Was: cloud containers) | — | — | — | Hosting ended 2025-07-08 | — | — | — | — | Shut down; a warning about free-tier economics and abuse |
| **Val Town** | **Cloud Deno isolates** (serverless "vals": HTTP, cron, email) | No (CLI `vt` syncs vals to local folders) | No | Built-in versioning/branches; vt CLI + git **(?)** | Val Town only (code is plain Deno/TS, so fairly portable) | Built-in **SQLite (Turso/libSQL)**, blob storage | **Townie** agent (Claude). **MCP server** to drive Val Town from external agents; easy to host MCP servers as vals | No (vt CLI OSS) | Free + Pro/Teams (usage-included AI credits) | Small-scale serverless, no long-running processes |
| **Cloudflare Workers Playground** | Code runs **on Cloudflare's edge preview service**, not in the browser (UI in browser) | No | No | No (share link; deploy) | Cloudflare Workers | **No bindings** (no KV/D1/DO) in the playground | None | workerd is OSS (Apache-2.0); playground not | Free | No state/bindings, single file, prototyping only |
| **Cloudflare Sandbox SDK / Containers / Dynamic Workers / VibeSDK** | Sandbox SDK: **containers on Cloudflare** behind a Durable Object. Dynamic Workers: **V8 isolates** loaded at runtime with LLM-generated code | No | No | git inside sandbox | Cloudflare (Workers for Platforms) | **Durable Objects (SQLite-backed)**, D1, KV, R2; Dynamic Workers can have DOs ("each AI app its own database") | Built for agents: Agents SDK, Code Mode, sandboxes; **VibeSDK** = OSS prompt-to-app platform deploying to Workers | VibeSDK OSS (MIT **(?)**); workerd OSS; platform closed | Usage-based (active-CPU for containers) | Cloudflare-only; Containers/sandboxes are cloud-side |
| **Deno Deploy Playground (+ Deno Sandbox)** | Cloud Deno isolates (Deploy). Sandbox: Linux microVMs | No | No | GitHub deploy (Classic: one-way export) | Deno Deploy (deno.net). Moderate lock-in (Deno KV) | Deno KV, Postgres/DB integrations **(?)** | Deno Sandbox API for agents (pre-release); no IDE agent **(?)** | Deno runtime MIT; Deploy closed | Free tier + usage | Playground = single-app prototyping |
| **Expo Snack** | Bundled in cloud/browser; runs in **Expo Go on a phone** or a web player | No | No | Git import **(?)** | Expo/EAS (export) | None | None notable | Snack is OSS (MIT) | Free | React Native demos only |
| **CodePen 2.0 / JSFiddle** | **Browser** (iframe). CodePen 2.0 adds a server-side "Compiler" for builds **(?)** | No | No | No (CodePen: export) | CodePen "Deploys" (static) **(?)** / none | None | None (CodePen: AI "under experimentation") | No | Freemium (CodePen Pro) | Front-end snippets, not apps |
| **JupyterLite** | **Browser WASM (Pyodide/Xeus)** | Browser storage; local FS via FSA plugin **(?)** | **Yes** (static site) | No | Static hosting | Browser storage only | jupyter-ai exists for JupyterLab; limited in Lite **(?)** | Yes (BSD) | Free | Python packages limited to WASM builds; no server |
| **marimo** | Local Python server **or browser WASM (Pyodide)**; molab cloud | **Yes** (notebooks are .py files on disk) | Yes (local) | Yes (plain .py, git-friendly) | Static WASM export / any Python host | Python process state; SQL cells | Built-in AI assist; MCP server mode **(?)**; agent-friendly file format | Yes (Apache-2.0) | Free (cloud molab freemium) | Python-only, notebook paradigm |
| **Observable (Notebooks 2.0 / Framework)** | **Browser JS** (reactive runtime) | **Yes via Observable Desktop** (macOS, local HTML files) | Desktop yes **(?)** | Yes (file format designed for git) | Static sites (Notebook Kit/Framework) | Data loaders at build time | AI assistant in 2.0 **(?)** | Notebook Kit + Framework OSS (ISC); Desktop closed, account required | Freemium/teams | Data-viz focus; Desktop Mac-only |
| **Eclipse Theia / Theia IDE / Theia AI** | Self-hosted server (Node) + browser or Electron | Desktop version yes; browser version = server FS | Desktop yes | Yes (git extension) | None (IDE framework) | N/A | **Theia AI**: open agent framework, MCP client, MCP registry (1.73), agent plugins/memory (1.75) | Yes (EPL-2.0); Theia Cloud for k8s | Free (OSS) | A framework to build IDEs, not a runtime/platform |
| **OpenVSCode Server / code-server** | Self-hosted server, browser UI | Server's FS | No (needs server) | Yes | None | N/A | VS Code extensions (Copilot limits on non-MS builds), MCP via extensions | Yes (MIT) | Free | Needs a server; Open VSX marketplace only |
| **E2B** | Cloud **Firecracker microVMs** | No | No | git inside VM | Infrastructure | Sandbox FS; persistence/pause features | **Agent sandbox API** (Code Interpreter SDK); MCP integrations | Core infra OSS (Apache-2.0), self-hostable (complex) | Usage per second + plans | Cloud execution only |
| **Daytona** | Cloud containers (hardened) / customer infra | No | No | git inside | Infrastructure | Persistent sandboxes | Agent sandbox API/SDK, MCP | **Closed source since 2026-06**; Nightona fork (AGPL) | Usage-based | Licensing change; cloud-only |
| **Modal (Sandboxes)** | Cloud gVisor containers (VM runtime added 2026 **(?)**), GPUs | No | No | — | Modal functions/apps | Volumes, Dicts, Queues | Sandbox API used by agent builders | No | Usage per second (premium) | Python-centric, priciest per vCPU |
| **Vercel Sandbox** | Cloud **Firecracker microVMs** (GA Jan 2026) | No | No | Clone repos | Vercel | Ephemeral FS, snapshots | SDK for agents; powers v0 | No (SDK OSS) | Active-CPU + memory | Ephemeral, Vercel-tied |
| **Dyad** | **Local desktop app (Electron)**; runs the app with local Node | **Yes**: projects are local folders | Partial (fully offline with Ollama/LM Studio) | Yes (local git, GitHub) | Vercel deploy; or anywhere | Supabase or **Neon** (DB branching used for undo) | Built-in agent (BYO model keys, local models); **MCP client support** | Apache-2.0 core + paid Pro features (license split **(?)**) | Free OSS + Pro ~$20/mo | Needs install; React/Next stack bias; backend is external cloud DB |
| **Same.new** | Cloud | No | No | Export **(?)** | Netlify **(?)** | Limited | Built-in agent (UI cloning focus) | No | Credits | Front-end cloning focus **(?)** |
| **Leap.new (Encore)** | Cloud | No | No | GitHub | **Your own AWS/GCP via Encore Cloud** or Docker self-host (low lock-in) | Encore.ts infra primitives (Postgres, pub/sub, cron) declared in code | Built-in agent; Encore local-dev MCP server **(?)** | Encore framework OSS (MPL-2.0); Leap closed | Credits/subscription **(?)** | Little 2026 activity found **(?)** |
| **Convex Chef** | Cloud (WebContainers for preview **(?)**) + Convex backend | No | No | Export | **Convex** (reactive DB) | Convex reactive DB, functions, auth | Built-in agent; Chef OSS so agents can be self-run | **Yes (Apache-2.0)**; Convex backend also OSS | Free / Convex usage | Tied to Convex backend model |
| **Base44 (Wix)** | Cloud | No | No | Limited/exported code **(?)** | Base44/Wix hosting. **High lock-in** (proprietary backend, no self-host) | Built-in managed DB/auth | Built-in agent, own model "Base1" | No | Credit subscription | Proprietary backend, no-code audience |
| **Puter** | **Browser "internet OS"** + Puter cloud backend (puter.js) | Cloud FS (user-pays model); self-hosted instance FS | No | Some dev apps **(?)** | Puter subdomain hosting | puter.js KV, cloud FS, AI APIs ("user pays") | puter.js exposes AI APIs; not an agent-native IDE | **Yes (AGPL-3.0; puter.js Apache-2.0 (?))**, self-host alpha | Free / user-pays | A web desktop, not a dev-runtime platform |

---

## 3. Categories and notes

### A. Prompt-to-app "vibe coding" builders (cloud)
**Replit Agent, Lovable, v0, Bolt.new, Base44, Same.new, Leap.new, Convex Chef, Google AI Studio Build (and Firebase Studio, now sunsetting).**
- They compete on **agent quality and the hosted backend** (Supabase, Lovable Cloud, Replit DB/Postgres, Convex, Firestore, Base44). Revenue comes from **credits/effort-based pricing**, and users widely complain that costs are hard to predict.
- **Git is increasingly first-class** (v0 makes a branch per chat; Lovable and AI Studio sync both ways with GitHub). They still store the working copy in their cloud: **none edits the user's local folder directly**.
- Lock-in sits in the **backend and runtime** (auth, DB, hosting), not in the code. Leap/Encore (deploy to your own cloud) and Convex Chef (OSS) are the more open ones.
- External-agent access is emerging: **Replit MCP server (beta)** and the **v0 Platform API (GA Aug 2026)**. These are mostly "drive our cloud agent" APIs. They do not give an external agent the runtime itself.

### B. In-browser execution runtimes
**StackBlitz WebContainers (+ Bolt, bolt.diy), CodeSandbox Sandpack/Nodebox, JupyterLite, marimo-WASM, Observable, CodePen/JSFiddle, Expo Snack web player.**
- WebContainers are the only mature product that runs a **Node.js-compatible server inside the tab**. They emulate an **OS (Node + npm + process model)**, not a deployment target. Nothing built in WebContainers runs unchanged on the production edge. The runtime is **proprietary, and commercial use needs a license**.
- **No in-browser runtime models durable server state** (Durable Objects, SQLite per object, alarms, WebSocket hibernation). In-browser preview state disappears on reload or lives only in IndexedDB, and **dev and prod runtime semantics differ**.
- Notebook tools (marimo, Observable 2.0, JupyterLite) are the **most local-first and file-based** in this space: plain files, git-friendly, offline-capable. They are good models for a file format and workflow, but they cover only a narrow area (data/Python).

### C. Cloud development environments (full VMs/containers, human IDEs)
**GitHub Codespaces, Ona (ex Gitpod), Firebase Studio (sunsetting), Replit workspace, Theia Cloud / OpenVSCode Server / code-server (self-host).**
- They give you a real Linux machine with any stack and full fidelity. In exchange they **cost money, have cold starts, need the network, and offer no offline or local-first mode**.
- The direction is clear: **CDEs are becoming agent-execution environments**. Ona re-founded itself around agents, Codespaces is the base for Copilot agent mode and the cloud agent, and Theia added an MCP-native "Theia AI".
- github.dev/vscode.dev show the **opposite extreme**. vscode.dev can **open a local folder via FSA**, but it **cannot run code**. That is exactly the gap CellB fills.

### D. Edge / serverless playgrounds
**Cloudflare Workers Playground, Deno Deploy Playgrounds, Val Town.**
- Quick feedback and zero setup, and they deploy to the real edge runtime. Code runs **remotely**, the playgrounds **lack bindings and state** (the CF playground has no DO/KV/D1), and they are not local-first.
- Val Town is the closest in spirit to "tiny full-stack apps with built-in state (SQLite) plus an AI agent plus MCP". It is hosted only, though.

### E. Agent sandboxes (infrastructure for external agents)
**E2B, Daytona (now closed), Modal, Vercel Sandbox, CodeSandbox SDK / Together Code Sandbox, Cloudflare Sandbox SDK / Dynamic Workers, Deno Sandbox.**
- This is now a commodity market: microVM (Firecracker) or gVisor isolation, about 100 ms to 1 s starts, per-second or active-CPU billing. **Cloudflare Dynamic Workers** push isolate-based sandboxes (about 100x faster start than containers) **with Durable Objects per generated app**. That design is very close to our server model, but it lives only in Cloudflare's cloud.
- All of them are **remote, paid, and stateless or ephemeral by default**. None is local-first. Their APIs (exec, fs, preview URL, snapshot) are the **de facto contract external agents expect**, and we should offer something similar.

### F. Local-first AI app builders / IDE frameworks
**Dyad, bolt.diy (self-host), Eclipse Theia (desktop), marimo, Observable Desktop.**
- **Dyad** is the closest "local-first AI app builder": the project lives in a local folder, models can be local, MCP client support, Apache-2.0 core. But it **needs an Electron install**, runs a regular local Node toolchain, and **delegates state to cloud DBs (Supabase/Neon)**. There is no isomorphic deploy runtime.
- **Theia AI** is the most open agent-in-IDE framework (MCP client and registry, agent plugins). It is a candidate foundation or reference, not a competitor runtime.

### G. Other / adjacent
- **Puter**: an open-source "internet OS" with puter.js (cloud FS, KV, AI, hosting; "user pays"). It is interesting as a browser-centric app platform with self-hosting, but it is not a dev runtime.
- **Expo Snack, CodePen 2.0, JSFiddle**: snippet and demo tools. CodePen 2.0's build "Blocks" are a modern take on in-browser builds, but CodePen is front-end only and has no AI.
- **Glitch**: dead (hosting ended July 2025). It shows how hard it is to host free apps (cost and abuse), which matters for any free "deploy" tier.

---

## 4. Gaps / opportunity relative to our concept

1. **Nobody combines "edit the real local folder" with "run the full stack in the tab".** vscode.dev has FSA but no execution. WebContainers execute but use an in-memory FS with GitHub import. Dyad is local but needs an installed desktop app. **FSA + in-tab full-stack execution with no install is an open niche.** (Caveat: FSA is Chromium-only; Safari/Firefox support only OPFS. Plan a fallback.)
2. **No platform has dev and prod on the same runtime semantics for stateful backends.** WebContainers emulate Node, then you deploy to Netlify/Vercel. Cloudflare has the right prod model (DO + SQLite, Dynamic Workers), but dev means `wrangler dev`/workerd locally or remote previews. **An in-browser Durable Objects runtime (CellB) that deploys unchanged to Cloudflare or a self-hosted isomorphic server is unique.** The closest relatives are Cloudflare Dynamic Workers (cloud-only) and Val Town (hosted Deno + SQLite).
3. **Durable state is the weak spot of browser runtimes.** Every in-browser tool treats the backend as stateless or outsources it to Supabase/Neon/Convex/Firebase. Per-object SQLite DOs persisted in OPFS or the local folder, then migrated or exported to prod, would be a real technical differentiator and would remove the "backend lock-in" that the vibe-coding builders make money from.
4. **Agent-native today mostly means "our cloud agent plus credits".** External-agent interfaces are bolted on (Replit MCP beta, v0 API, Lovable none or limited). Agent sandboxes give external agents a runtime but charge per second in the cloud. Opportunity: **expose the in-tab workspace (fs, build, run, logs, DO state inspection, tests, git, deploy) as MCP/HTTP tools from day one**. Then any agent (Claude Code, Copilot, Cursor, a local agent) can drive it, and **execution costs nothing because it runs in the user's browser**. Make every UI action an API call (agent/human parity) and give agents structured diagnostics.
5. **Offline / local-first.** Apart from notebooks (marimo, JupyterLite, Observable Desktop) and Dyad-with-Ollama, everything needs the network. A runtime that works offline (with cached packages) and syncs through git is rare. Notebook tools show developers value **plain files + git**. Avoid a proprietary project format.
6. **Openness and licensing are a wedge.** WebContainers need a commercial license, Daytona closed its source, and the vibe builders are closed. An **open (or source-available) runtime with an OSS self-host path** (like workerd, Theia, marimo) is a credible differentiator, especially since "deploy to your own server" is part of the pitch.
7. **Cost structure.** Cloud builders bill for compute plus LLM, and agent sandboxes bill per second. Running in the tab moves the compute cost of dev, preview and agent test loops to the client. That allows a generous free tier without the Glitch-style hosting economics problem (hosting stays opt-in via Cloudflare or self-host).
8. **Risks / things competitors do better.**
   - Fidelity: WebContainers took years to reach npm/Node compatibility. CellB needs a clear compatibility story (the Workers API surface, nodejs_compat subset, npm packages that need native addons won't work, the same constraint as Dynamic Workers).
   - Breadth: CDEs run any language. We are JS/TS (+WASM) only. Position as "Workers-shaped apps", not general dev.
   - Cloudflare itself could ship an in-browser workerd/DO playground. Today the playground runs remotely and has no bindings. Watch Dynamic Workers and VibeSDK.
   - Browser limits: FSA Chromium-only, memory caps, no raw TCP. Some DB clients and protocols need proxies.

---

## 5. Sources

Status / news
- Glitch shutdown: https://www.theregister.com/2025/05/23/glitch_app_hosting_gone , https://support.glitch.com/t/glitch-shutting-down/75658 , https://wiki.archiveteam.org/index.php/Glitch
- Gitpod → Ona: https://www.theregister.com/2025/09/03/gitpod_rebrands_as_ona/ , https://ona.com/stories/gitpod-classic-payg-sunset , https://ona.com/stories/migrating-from-classic-to-ona , https://www.infoq.com/news/2025/09/gitpod-ona
- Firebase Studio sunset: https://firebase.google.com/docs/studio/migrating-project?hl=en
- Google AI Studio Build mode: https://ai.google.dev/gemini-api/docs/aistudio-build-mode
- CodeSandbox / Together: https://together.ai/blog/codesandbox-acquisition-together-code-interpreter , https://codesandbox.io/blog/codesandbox-sdk , https://codesandbox.io/docs/learn/repositories/migration-guide , https://sandpack.codesandbox.io/docs/resources/faq , https://rywalker.com/research/codesandbox-sdk
- Daytona closed source: https://daytona.io/dotfiles/updates/daytona-is-going-closed-source , https://www.agent37.com/blog/daytona-alternative
- Cloudflare: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ , https://developers.cloudflare.com/sandbox/ , https://infoq.com/news/2026/04/cloudflare-sandboxes-ga , https://blog.cloudflare.com/dynamic-workers , https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader , https://infoq.com/news/2026/04/cloudflare-dynamic-workers-beta , https://www.plushcap.com/content/cloudflare/blog/cloudflare-durable-objects-in-dynamic-workers-give-each-ai-generated-app-its-own-database , https://github.com/cloudflare/vibesdk , https://developers.cloudflare.com/workers/playground/
- Vercel / v0: https://vercel.com/blog/introducing-the-new-v0 , https://v0.dev/docs/v0-platform-api , https://infoq.com/news/2026/08/vercel-v0-api , https://venturebeat.com/infrastructure/vercel-rebuilt-v0-to-tackle-the-90-problem-connecting-ai-generated-code-to
- Replit: https://docs.replit.com/billing/ai-billing , https://docs.replit.com/references/mcp/overview , https://docs.replit.com/updates/2026/06/26/changelog , https://docs.replit.com/updates/2026/07/31/changelog , https://chatforest.com/builders-log/replit-agent-4-creativity-parallel-agents-effort-pricing/ , https://nodeops.network/blog/replit-agent-to-production-2026
- Bolt / StackBlitz / WebContainers: https://raw.githubusercontent.com/stackblitz-labs/bolt.diy/HEAD/README.md , https://webcontainers.io/enterprise , https://www.morphllm.com/bolt-vibe-coding , https://research.contrary.com/reports/bolt , https://automationatlas.io/answers/bolt-new-review-2026/
- Lovable: https://aimagazine.com/news/lovable-europes-vibe-coding-platform-crosses-us-600m-arr , https://www.vktr.com/ai-platforms/lovable-raises-400-million-at-133-billion-valuation/ , https://vibecoding.app/blog/lovable-review-2026
- Deno: https://docs.deno.com/deploy/reference/playgrounds/ , https://docs.deno.com/sandbox/ , https://deno.com/deploy/sandboxes
- Val Town: https://docs.val.town/guides/prompting/townie , https://www.val.town/x/valdottown/blog/code/posts/2026-03-05-newsletter-26.md
- GitHub Codespaces / VS Code: https://github.blog/changelog/2025-04-11-vscode-copilot-agent-mode-in-codespaces/ , https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases , https://code.visualstudio.com/blogs/2025/11/03/unified-agent-experience
- Theia: https://eclipsesource.com/blogs/2026/07/07/eclipse-theia-1-73-release-news-and-noteworthy/ , https://eclipsesource.com/blogs/2026/06/25/eclipse-theia-news-from-the-next-gen-tools-platform/ , https://theia-ide.org/resources
- Agent sandboxes comparisons: https://upstash.com/blog/ai-agent-sandbox-providers-compared-2026 , https://hub.superagent.sh/blog/ai-code-sandbox-benchmark-2026 , https://northflank.com/blog/e2b-vs-vercel-sandbox , https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/
- Dyad: https://dyad.sh/ , https://github.com/dyad-sh/dyad , https://neon.com/blog/building-versioning-for-ai-generated-apps , https://blog.openreplay.com/practical-intro-dyad-local-ai-app-builder/
- Convex Chef: https://news.convex.dev/open-kitchen-chef-is-now-oss/
- Leap / Encore: https://encore.dev/blog/leap-is-here
- Base44 / Wix: https://techcrunch.com/2026/06/29/vibe-coding-platform-base44-launches-own-model-as-ai-startups-seek-defensibility , https://thenextweb.com/news/base44-base1-proprietary-ai-model-vibe-coding
- Same.new: https://aiidelist.com/ide/same-new.md (third-party only)
- Notebooks: https://coreweave.com/news/coreweave-acquires-marimo-to-unify-the-generative-ai-developer-workflow , https://simonwillison.net/2025/Oct/31/coreweave-acquires-marimo , https://observablehq.com/notebook-kit/ , https://observablehq.com/notebook-kit/desktop , https://macwright.com/2025/07/31/observable-notebooks-2 , https://jupyterlite.readthedocs.io/
- CodePen 2.0: https://blog.codepen.io/2026/07/23/two-point-oh/ , https://codepen.io/features/compiler , https://chriscoyier.net/2026/07/30/codepen-2-0/
- Expo Snack: https://expo.dev/tools , https://github.com/expo/snack
- Puter: https://github.com/HeyPuter/puter , https://itsfoss.com/news/puter-office-integration.md

Note: several pricing figures and some 2026 details come from third-party review or aggregator sites. These are marked **(?)** in the table where they matter. Check the vendor pages before quoting them externally.
