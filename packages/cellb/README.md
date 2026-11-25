# @statewalker/cellb

cellb is a Durable Objects runtime written in TypeScript that runs the same Workers code in a
browser and in Node. A Worker module and its Durable Object classes, unmodified, get synchronous
SQLite storage, input and output gates, stubs with `fetch` and RPC, alarms, WebSockets, Worker
Loaders and facets. In a browser the cells live in SQLite on OPFS inside Dedicated Workers and are
reached through a ServiceWorker; in Node they live in `node:sqlite`. Cells are stored exactly as
celld stores them, so one cell can move between cellb in a browser, cellb in Node and celld nodes
through one bucket.

## Why it exists

Workers and Durable Objects normally need a server: Cloudflare, workerd (which Miniflare wraps) or
celld, all native binaries. That leaves out a browser tab, which can hold durable state in OPFS
but cannot run a binary, accept a socket, or start a server. cellb is the runtime written for that
constraint: pure TypeScript, synchronous SQLite through WebAssembly, HTTP through a ServiceWorker,
WebSockets over MessagePorts. The same core runs in Node, so a project behaves the same on both.

celld is the reference, not an afterthought. cellb answers every recorded celld request the same
way, stores cells in celld's format, and speaks celld's ownership and peer protocols, so a fleet can
mix celld nodes, cellb nodes and browsers.

## How to use it

```sh
npm install @statewalker/cellb
npm install esbuild   # for loadProject and cellb build on Node (an optional peer dependency)
```

The package has three entry points, one per platform, and two more for bundling. Published, it is
JavaScript with type declarations (`dist/`, built by `scripts/build.mjs`); in this repository the
entry points are the TypeScript sources, which cellb's tests and browser pages import directly
(the examples, in a workspace of their own, use the published package).
In a browser app, a bundler must handle `new Worker(new URL("…", import.meta.url))`: the LTX store
worker is started that way (checked with a Vite build, see `scripts/pack-check.mjs`).

| Import | What it gives |
|---|---|
| `@statewalker/cellb` | the runtime (`createCellRuntime`, `createProjectRuntime` with `loadProjectBindings`), `DurableObject` and `WorkerEntrypoint`, the ports and `CellStorage`, `celldBucket`, the object stores (`s3ObjectStore`, `memoryObjectStore`, `filesApiObjectStore`), `filesApiLtxLog`, `filesApiChangeLog`, `filesApiBackup`, `wasmMemoryOpener` (in-memory SQLite WASM), links over ports, `CellRouter`, `createShardWorker`, the WebSocket classes (and `withUpgrade`, for an upgrade request a browser can make), and the errors embedders catch |
| `@statewalker/cellb/node` | `loadProject` and `buildProject` (the `cellb build` command), `createFragmentHost` (many projects side by side, at `/fragments/{id}/`), `nodeSqliteOpener`, `sqliteObjectStore` (celld dev's local bucket), `loadNodeProject`, `startProjectShards` (a project over worker threads), `applyNodeD1Migrations`, celld's peer protocol (`startCelldPeerServer`, `celldPeers`), and `startFleetNode` (the `cellb serve` command: a node of a celld fleet) |
| `@statewalker/cellb/browser` | `loadProject` (a `cellb build` folder by URL, or sources with a compiler), `browserProjectRuntime`, `startProjectShards`, `joinProjectShards` and `serveProjectShard` (shards in workers and tabs), `joinFragmentShards` and `serveFragmentShard` (the fragment host's pool), `installProjectRouter` (the ServiceWorker side), `sahpoolOpener`, `idbObjectStore`, `serviceWorkerConnector` |
| `@statewalker/cellb/tabs` | the tab side and the ServiceWorker side of a project shared by the tabs (`joinProjectShards`, `installProjectRouter`, `shardOwner`), and of the fragment host's pool (`joinFragmentShards`), without the shard runtime: what a page and its ServiceWorker import |
| `@statewalker/cellb/site` | `createProjectSite`: a project's sources compiled in the browser and served by an in-browser HTTP server (`browserProjectRuntime({ site })`); `siteCompiler` for `loadProject`, and `siteHostOverPort` / `hostSitesForWorker` to host a worker's site from its page. Needs the optional peer dependencies `@statewalker/webrun-modules`, `@statewalker/webrun-site-builder` and `@statewalker/webrun-site-host` (the ServiceWorker host) |
| `@statewalker/cellb/bundle` | `bundleCompiler`: a project's sources bundled in the browser for `loadProject`, with webrun-bundler on esbuild-wasm. Needs the optional peer dependency `@statewalker/webrun-bundler`; the caller passes esbuild-wasm, initialized |
| `@statewalker/cellb/host-modules` | for bundlers other than cellb's own (webrun-bundler in a browser, say): the sources of `cloudflare:workers`, `node:*` and the Workers globals as cellb's realms provide them (`cellbHostModule`, `CELLS_GLOBALS_MODULE`) |
| `@statewalker/cellb/isolate-worker` | the Dedicated Worker that runs a Worker-Loader Worker in a realm of its own (`isolateScript`) |

Node 22.13 or later is needed for `node:sqlite`. `loadNodeProject` bundles a project with
`esbuild`, which the embedder must install.

A runtime is a `(Request) ⇒ Response` handler: mount `runtime.fetch` on `node:http`, a
ServiceWorker or a test, and call `runtime.close()` when done. `close()` aborts the signal of the
requests in flight (the Worker's and its objects', as when a client goes away on Cloudflare: a long
poll or an SSE stream ends), gives events still running and `waitUntil` work `closeGraceMs` (2 s) to
finish, takes final backups, closes every database, then closes the storage. After that, the
runtime answers requests with 503, and an object's code still running fails with
`ObjectClosedError` when it uses its storage or another object.

## Examples

### One project loader for Node and browsers

`loadProject(source, options)` has the same name and options in both entry points:

```ts
// Node: a folder with wrangler.json(c), its `main` bundled with esbuild
import { loadProject } from "@statewalker/cellb/node";
const project = await loadProject("./counter", { data: "./data" });

// Browser, in a Dedicated Worker: the URL of a folder written by `cellb build`
import { loadProject } from "@statewalker/cellb/browser";
const project = await loadProject("/apps/counter/", { data: "counter" });

// Both
const res = await project.fetch(new Request("http://localhost/increment?name=alpha"));
project.unsupported; // configuration cellb does not run
await project.close();
```

A browser loads a project built ahead of time, on Node:

```sh
npx cellb build ./counter --out public/apps/counter
```

The folder holds `wrangler.json`, `worker.js` (`main` bundled for browsers, with nodejs_compat
when the flags ask for it), `assets/` (the files of `assets.directory`) and `cellb.json`, the
manifest that lists the assets, since a static host cannot list a folder. Any static host serves
it; Node loads it too.

- `source`: Node takes a folder (built or not), a `file:` or `http(s):` URL of a built folder, or
  a FilesApi holding either; a browser takes the URL of a built folder or a FilesApi holding one,
  or, with `compile`, a FilesApi holding the sources.
- `compile` (browser): how a source folder becomes code, below. Without it, a browser loads only
  `cellb build` folders.
- `data`: where cells keep their data. On Node, a directory (SQLite files, and the project's files
  under `<data>/files`); without it, memory. In a browser, an OPFS name: the SQLite pool `<data>`
  and the files directory `<data>-files` (default: the project's `name`).
- `bucket`: a fleet bucket, as `loadNodeProject`'s `storage` (a `CellStorage`) and
  `browserProjectRuntime`'s `bucket` (a `BrowserBucket`).
- `ai`: the Workers AI endpoint. `sqlite3` (browser): a SQLite WASM module, if the caller has one
  (default: `@sqlite.org/sqlite-wasm`). `isolateScript` (browser): where Worker Loader code runs,
  the package's own isolate worker by default, `false` for this realm.

`loadNodeProject` and `browserProjectRuntime`, below, stay as the lower-level calls.

### Sources in a browser: `compile`

A browser compiles a project's sources (`wrangler.jsonc` and `main` at the root of a FilesApi,
`package.json`, assets) when `loadProject` is given a compiler. The compilers come from their own
entry points, so a plain `loadProject` ships neither:

```ts
// One ES module, bundled by webrun-bundler on esbuild-wasm. npm packages come from the project's
// node_modules, else the npm registry, at package.json's ranges.
import * as esbuild from "esbuild-wasm";
import { bundleCompiler } from "@statewalker/cellb/bundle";
await esbuild.initialize({ wasmURL });
const project = await loadProject(files, { data: "app", compile: bundleCompiler({ esbuild }) });

// Modules compiled one by one by webrun-modules, served from the page's ServiceWorker (a change
// recompiles one module). A Dedicated Worker cannot register a ServiceWorker: its page hosts the
// site, with hostSitesForWorker(worker).
import { siteCompiler, siteHostOverPort } from "@statewalker/cellb/site";
const project = await loadProject(files, {
  data: "app",
  compile: siteCompiler({ host: siteHostOverPort(self) }),
});
```

Both lower `await` for nodejs_compat as `cellb build` does (AsyncLocalStorage follows
continuations), and take `cloudflare:workers`, the Workers globals and `node:*` from the runtime.
A source folder loads from a FilesApi only: a static host cannot list it.

### A Worker and a Durable Object in Node

```ts
import { createCellRuntime, DurableObject } from "@statewalker/cellb";
import { nodeSqliteOpener } from "@statewalker/cellb/node";

class Counter extends DurableObject {
  increment(): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY, n INTEGER)");
    sql.exec("INSERT INTO c (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1");
    return sql.exec<{ n: number }>("SELECT n FROM c WHERE id = 1").one().n;
  }
}

const runtime = createCellRuntime({
  worker: {
    Counter,
    default: {
      fetch: async (req: Request, env: any) =>
        Response.json({ n: await env.COUNTER.getByName(new URL(req.url).pathname).increment() }),
    },
  },
  durableObjects: { COUNTER: { className: "Counter" } },
  openSql: nodeSqliteOpener("./data"), // a file per cell in an existing directory; () = in memory
});
const res = await runtime.fetch(new Request("http://local/counter/a")); // {"n":1}
await runtime.close();
```

### Many projects side by side: the fragment host

`createFragmentHost` (Node) holds the server halves of a fragment platform's fragments (#191;
statewalker-root ADR 2026-11-21-fragment-host-and-routing). Each one is a wrangler project loaded
from its sources into a namespace of its own, so two projects may use the same Worker name, class
and binding names without sharing a cell or any binding's data. Projects come and go while the
host runs. A request to `/fragments/{id}/{path}` reaches the project's **fragment DO**, the object
at `idFromName(<id>)` of its `FRAGMENT` binding (or of its only Durable Object binding, or of
`{ entry }`), with the path `/{path}`:

```ts
import { createFragmentHost } from "@statewalker/cellb/node";

const host = createFragmentHost({ data: "./data" }); // each fragment under ./data/fragments/<id>/
const notes = await host.add("org.example.notes", "./fragments/notes/server");
notes.unsupported; // this project's unsupported configuration only
const res = await host.fetch(new Request("http://local/fragments/org.example.notes/list"));
await host.remove("org.example.notes"); // stops its objects; its data is kept
```

A single-project host's data at the top of `data` is never touched by the fragment host. Built
folders (`cellb build`) are refused: their bundle reads the process's globals, so only one runs per
process. Add a fragment's source folder instead. Fragment ids are lowercase path segments
(`org.example.notes`).

**In a browser**, the fragment host is one pool of shard workers shared by the origin's tabs, each
worker holding every fragment, each fragment in OPFS pools of its own. The ServiceWorker's router
(`installProjectRouter`, unchanged) sends `<basePath>fragments/<id>/…` to the pool, and the
shard that takes a request reaches the fragment DO in the shard that owns it, as any call between
shards:

```ts
// ServiceWorker
installProjectRouter(self, { basePath: "/" });
// shard worker
serveFragmentShard({ sqlite3 });
// each page (every tab adds the same fragments)
const pool = await joinFragmentShards({ shards: 2, basePath: "/", spawn, serviceWorker });
const { unsupported } = await pool.add("org.example.notes", { config, code: { bundle } });
await fetch("/fragments/org.example.notes/list");
await pool.remove("org.example.notes"); // its data is kept
```

**Disabled and unknown fragments, and the host's own peer path** (statewalker-root#259).
`host.disable(id)` stops a fragment and keeps it known: its requests answer 503 and bindings to it
are unavailable, without waking its DO, until `host.enable(id)` loads it again from the source it
was added with (its data is kept; `state(id)` tells which). A fragment the host does not have
answers 404. With `createFragmentHost({ peerId })`, `/peers/{peerId}/fragments/{id}/…` answers as
`/fragments/{id}/…`. In a browser, the tabs tell the ServiceWorker their fragment table
(`joinFragmentShards`' `add`, `remove`, `disable`, `enable`, and its `peerId`), and the router
answers 404 and 503 itself, without waking a shard, and serves `<basePath>peers/<peerId>/…` as
`<basePath>…`.

**Service bindings between fragments** (#192). A project's `services: [{ binding, service,
entrypoint?, props? }]` naming another fragment of the host (by its id) is a working binding,
`fetch` and JS RPC, on Node and in a browser. Where a call runs follows the target's fragment DO:
on the caller's shard it is JS RPC in the runtime, on another shard a request through the router
(MessagePorts), and on another host, by the route table the host is given, HTTP to
`<url>/fragments/{id}/` or to `/peers/{peerId}/fragments/{id}/` through an HTTPeers gateway:

```ts
const a = createFragmentHost({
  routes: { "org.example.search": { host: "peer:peer-b" } }, // unlisted fragments are local
  remote: { peers: "https://gateway.example", fetch: meshFetch },
});
// on peer-b, behind its authenticated link: entrypoint calls and the fragments' fetch
const b = createFragmentHost({ peerId: "peer-b" });
serveAuthenticatedLink((request) => b.serveLink(request));
```

Contracts between fragments carry only structured-cloneable values and streams, in every
placement, so a binding behaves the same when a fragment moves: a function, an `RpcTarget`, a stub
or a `Request` in an argument or a result fails with a `DataCloneError` naming the call
(`services[API] → "org.example.search" Api.find(): the arguments[0].cb is a function; …`), and
at most one `ReadableStream` crosses per call and per answer. A binding is resolved at each call:
it works once its target is added, and a call while the target or the caller is not active
(removed, never added, or a host that cannot be reached) fails at once with
`ServiceUnavailableError`. `host.fetch` never runs entrypoint calls; `serveLink` does, so mount it
only where the peer is authenticated. `durable_objects.bindings[].script_name` stays unsupported:
a fragment reaches another's objects through its entrypoint.

One thing is still shared on Node: with `nodejs_compat`, a project's text vars land in the process's
`process.env` (Node shares its real process with the Worker), so a project reading
`process.env.X` may see another project's value. `env.X` is always the project's own.

### A wrangler project over several worker threads

```ts
import { startProjectShards } from "@statewalker/cellb/node";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

const app = await startProjectShards({
  shards: 4, // worker threads; each owns the cells shardOf(id, 4) gives it
  dir: "./counter", // wrangler.jsonc and its `main`, as loadNodeProject takes
  data: "./data", // thread i keeps its files in ./data/s<i>; memory without it
  files: new NodeFilesApi({ rootDir: "./backup" }), // optional: the cells' LTX log, their lasting copy
});
const res = await app.fetch(new Request("http://local/?name=a")); // round robin over the threads
await app.close();
```

A Durable Object call from any thread runs in the owner's, over a port between every two threads.
With `files`, the cells belong to that FilesApi (a folder, S3, memory): each run restores them
from it into temporary files, so a later run with another number of threads opens each cell where
the last run left it. Without `files`, the cells live in `data`, and that directory keeps the
thread count it was made with: a run with another count is refused rather than opening some cells
empty. Each thread's alarm index is its own: with `files` it is in memory, so an alarm set before a
restart fires once its object is used again.

### A wrangler project on a bucket shared with celld

```ts
import { celldBucket } from "@statewalker/cellb";
import { loadNodeProject, nodeSqliteOpener, sqliteObjectStore } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const dir = "./counter"; // wrangler.jsonc and its `main`
const { runtime, unsupported } = await loadNodeProject(dir, {
  // Every cell starts empty and is restored from the bucket on first use. pageCapture logs each
  // commit's pages from the WAL (O(changed pages)) instead of imaging the whole database per
  // commit; without a directory, cells live in temporary files removed when they close.
  openSql: nodeSqliteOpener(undefined, { pageCapture: true }),
  files: new MemFilesApi(), // blob store for large KV values
  storage: celldBucket(sqliteObjectStore(`${dir}/.celld/dev/objects.sqlite3`), { node: "cellb-1" }),
});
console.log(unsupported); // configuration entries cellb does not support, e.g. []
await runtime.fetch(new Request("http://localhost/increment?name=a"));
await runtime.close(); // releases the cells, so celld can take them at once
```

`sqliteObjectStore` is the bucket `celld dev` keeps in that file. A fleet on S3 uses
`s3ObjectStore({ endpoint, bucket, prefix, region, accessKeyId, secretAccessKey })` instead.

To run a project as a node of a celld fleet, next to celld nodes, use `cellb serve`, which takes
celld's node flags; requests for any cell, at any node, reach the cell's owner
([A mixed fleet](docs/celld-compatibility.md#a-mixed-fleet-cellb-as-a-celld-peer-node)):

```sh
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… npx cellb serve ./counter \
  --bucket s3://cells/fleet-a --endpoint http://127.0.0.1:9200 --listen 127.0.0.1:8080
```

A project with a Workers AI binding (`"ai": { "binding": "AI" }`) needs an OpenAI-compatible
endpoint behind it (llama.cpp, Ollama, a hosted API); without one, `ai` is in `unsupported`:

```ts
const { runtime } = await loadNodeProject(dir, {
  openSql: nodeSqliteOpener(),
  files: new MemFilesApi(),
  ai: {
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: process.env.LLM_KEY, // optional
    models: { "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "llama3", "*": "llama3" },
  },
});
```

`env.AI.run(model, inputs, options)` then answers text generation (`{ prompt }` or
`{ messages, tools?, stream? }`, in Workers AI's `{ response, tool_calls, usage }` shape or its
`data: {"response": …}` stream), the endpoint's own response with `returnRawResponse` (Flue's
`cloudflare` provider reads it), and embeddings (`{ text }`); other model kinds throw an `AiError`.
`browserProjectRuntime`, `startProjectShards` and `joinProjectShards` take the same `ai`.

### A wrangler project in a browser worker

```ts
// in a Dedicated Worker
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { browserProjectRuntime } from "@statewalker/cellb/browser";

const host = await browserProjectRuntime({
  config, // the parsed wrangler.jsonc
  code: { bundle }, // `main` bundled for browsers (or { site } for the in-browser HTTP server)
  sqlite3: await sqlite3InitModule(),
  pool: "my-app", // the OPFS SQLite pool; one per worker
  filesDir: "my-app-files",
});
const res = await host.runtime.fetch(new Request("http://browser/"));
await host.close();
```

Where the cells live is the `pool` (an opfs-sahpool SQLite pool, one per worker) unless `bucket`
says otherwise: `bucket: { idb, node }` keeps them in memory with page logs in IndexedDB, and
`bucket: { ltx, node }` keeps each one as LTX files in an OPFS directory, read page by page through
a SQLite VFS (cross-origin isolation needed). [docs/browser-host.md](docs/browser-host.md)
compares them.

To run each Worker-Loader Worker in a Dedicated Worker of its own, pass the shipped isolate worker:
with Vite, `import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url"` and
`isolateScript: new URL(isolateWorker, import.meta.url)`.

[docs/browser-host.md](docs/browser-host.md) shows how requests reach this worker through a
ServiceWorker, how to shard an origin, and how to put the cells on an S3 bucket shared with celld.

### A runtime behind a MessagePort

```ts
import { connectRuntime, serveRuntime } from "@statewalker/cellb";

const { port1, port2 } = new MessageChannel();
await serveRuntime(port1, runtime); // in the worker that owns the cells
const remote = await connectRuntime(port2); // in the page, or another thread
const res = await remote.fetch(new Request("http://local/counter/a")); // bodies stream
```

## Internals

### One core, and ports for what differs per platform

`src/core` knows nothing about the platform. It depends on the ports in `src/ports.ts`: a
synchronous SQLite driver per cell, a `CellStorage` bundle (durability, backup, ownership, R2
objects), a `Lease`, a `Clock`. The SQL port is synchronous because `ctx.storage.sql.exec()` is
synchronous in Workers, and both drivers are synchronous underneath (`node:sqlite`, and SQLite WASM
in a Dedicated Worker). [docs/architecture.md](docs/architecture.md) has the request path and the
layers.

### Where everything is

```
src/core            runtime, stubs, ids, gates, SQL and KV storage, alarms, celld's internal schema
src/ports.ts        the port interfaces and CellStorage
src/adapters        node:sqlite and SQLite WASM drivers, the WASM page hook, the LTX VFS, FilesApi logs and backups
src/bucket          object stores (S3, SQLite, memory, FilesApi), the LTX writer, celldBucket
src/ltx             the LTX v3 codec (LZ4, CRC-64, xxHash32), page reads and compaction over a FilesApi,
                    the LTX store worker and its OPFS files (bucket: { ltx })
src/v8              V8 serialization in TypeScript
src/transport       the HTTP surface of a runtime, and links over ports
src/router          CellRouter and the shard worker (browser origins)
src/ws              WebSocket client, WebSocketPair and 101 Response over MessagePorts
src/project         wrangler projects for Node and browsers, the in-browser site, Workers globals
src/bindings        assets, cache, cron, D1 migrations, HTMLRewriter, KV, Queues, R2, Workflows, Worker Loader
src/isolate         loaded Workers in a realm of their own (worker threads, Dedicated Workers)
src/peer            celld's peer protocol, server and client (Node)
src/node-compat     node:* modules for nodejs_compat in browsers
src/miniflare-compat  shims for Miniflare's vendored D1 simulator
vendor/             celld's KV, Queues and Workflows code; Miniflare's D1; html-rewriter-wasm
conformance/        celld examples, our projects, workerd's tests, recorded goldens
test/               unit tests (vitest, Node)
e2e/                tests against a real celld and RustFS (vitest; skipped without CELLD_BIN)
e2e-browser/        Playwright specs; pages/ holds the demo pages, the host app, ServiceWorker and
                    shard workers they drive, and labs/ (storage internals, measured; cross-origin isolated); probes/
                    the exploratory browser probes (ServiceWorker idling, the ltx and sqlite labs)
scripts/            vendoring, the interop environment, mutation harnesses
probes/             Node hypothesis probes (SQLite locks, webrun-modules globals)
docs/               topic pages
```

### Decisions a reader would otherwise undo

- **celld's storage format is the only one** — ids, internal tables, V8-serialized values, LTX
  logs — so cells move between cellb and celld without conversion
  ([docs/celld-compatibility.md](docs/celld-compatibility.md)).
- **KV, Queues and Workflows run celld's own JavaScript**, vendored unchanged, so a queue, workflow
  instance or KV namespace written by celld continues on cellb, and back.
- **celld judges conformance**, because cellb's storage must be celld's; workerd is recorded to
  pin where celld differs, and judges only where cellb follows it on purpose: stubs, functions and
  `RpcTarget`s pass by reference, and calls on a pending result are pipelined, which celld
  refuses ([docs/conformance.md](docs/conformance.md)).
- **The gates use no `AsyncLocalStorage`**, which browsers lack.
- **A browser origin has a fixed number of shards**, because an OPFS pool is exclusive per worker
  ([docs/browser-host.md](docs/browser-host.md)).
- **WebSockets travel over MessagePorts**, because a ServiceWorker cannot accept them. The client
  (`createWebSocketClass`) and the frames on the port are `webrun-http-browser`'s; the ends of a
  `WebSocketPair` are cellb's, with workerd's semantics. A port has no send buffer to measure, so
  the server end acknowledges the bytes of each message it dispatched and a client's
  `bufferedAmount` counts the bytes not acknowledged yet: the WHATWG signal a sender throttles on.
  workerd's server-side WebSocket has no `bufferedAmount`, and cellb's has none.
- **Each loaded Worker gets a realm of its own**, a worker thread in Node, or in a browser a
  Dedicated Worker when `isolateScript` is set (the browser `loadProject` sets it;
  `browserProjectRuntime` and the shard functions do not): as in celld's isolates, loaded code must
  not see the host's globals or env.
- **`idFromName` is synchronous**, with `@noble/hashes` instead of `crypto.subtle`, which is
  asynchronous only; Worker code relies on getting the id at once.
- **Ownership depends on the deployment**: a Web Lock per shard in an origin, celld's ownership
  records per cell on a fleet bucket
  ([docs/ownership-and-durability.md](docs/ownership-and-durability.md)).
- **An idle database closes without letting go of its cell.** `hibernateAfterMs` drops an idle
  object's instance; `closeDatabaseAfterMs` (longer, opt-in) also closes its SQLite handle, and the
  next event reopens it. The cell lease is kept: taking the cell again would start a new generation,
  whose first commit uploads the whole database. It is off by default because an in-memory database
  without a log or backup would come back empty; a cell whose last changes are not backed up yet
  stays open until they are.

What cellb does not do yet is in [docs/gaps.md](docs/gaps.md); how it matches celld is in
[docs/celld-compatibility.md](docs/celld-compatibility.md), and service by service (KV, D1, R2,
Queues, Workflows, …) in [docs/services/](docs/services/). What is isolated, and what is not, is in
[docs/security.md](docs/security.md). The vocabulary is in [CONTEXT.md](CONTEXT.md).

### Dependencies, and why

- `@sqlite.org/sqlite-wasm` — SQLite in browsers (opfs-sahpool needs no COOP/COEP headers);
  `sqlite-vec` for celld's `sqlite_vec` flag.
- `@noble/hashes` — synchronous SHA-256 and HMAC for object ids.
- `@statewalker/webrun-rpc`, `webrun-http-streams`, `webrun-streams` — HTTP with streaming bodies
  over MessagePorts.
- `@statewalker/webrun-files` — the FilesApi for logs, backups and KV blobs;
  `webrun-http-browser` — the HTTP links over MessagePorts, the WebSocket client and its frames.
- Optional peers, for `@statewalker/cellb/site` only: `webrun-modules` (compiles a project's
  sources in the browser; it brings lightningcss-wasm and @jspm/core, about 30 MB),
  `webrun-site-builder` (the in-browser HTTP server), and `webrun-site-host` (hosts it in a
  ServiceWorker: `siteCompiler`, `hostSitesForWorker`). Projects that run a bundle (`{ bundle }`)
  need none of them, and their builds emit none of their assets.
- Optional peer, for `@statewalker/cellb/bundle` only: `webrun-bundler` (with esbuild-wasm, which
  the caller passes in).
- `worker-timers` — unthrottled heartbeat timers on a page's main thread.
- `buffer`, `events`, `util`, `assert`, `path-browserify` — `nodejs_compat` in browsers.

### What will surprise you

- **`ERR_MODULE_NOT_FOUND` for `…/src/…/*.js` when importing this repository's sources with plain
  `node`.** In the workspace the entry points are TypeScript; use vitest or tsx there, or the
  published package (`pnpm pack`).
- **`Durable Object <Class>/<id> is owned by another node`** (`CellOwnedElsewhereError`). Another live
  node owns the cell in the fleet bucket. Pass `peers` to route to it, or wait for it to release the
  cell or for its node lease to expire.
- **`Durable Object reset because …`** (`BrokenObjectError`). A commit did not become durable, the
  constructor's `blockConcurrencyWhile()` failed, or the cell lease was lost. The next call builds a
  fresh instance.
- **`unable to open database file`** from `nodeSqliteOpener(dir)` or `sqliteObjectStore(file)`. The
  directory does not exist; neither creates it. (`celld dev` creates `.celld/dev/` on its first run.)
- **`NoModificationAllowedError` in a browser.** Two workers opened the same OPFS pool. Each worker
  needs its own `pool`.
- **`storage quota exceeded writing …`** or **`ltx: cell … is open in another tab or worker`** with
  `bucket: { ltx }`: the origin's storage is full, or another tab's store holds the cell. See
  [docs/browser-host.md](docs/browser-host.md#what-breaks).
- **`A stub was used after it was disposed.`** Loaded code, or its host, called a stub of the other
  side after `stub[Symbol.dispose]()`. A stub into a loaded Worker holds its value until disposed or
  garbage-collected ([docs/gaps.md](docs/gaps.md)).
- **`DataCloneError: Functions, RpcTargets and stubs cannot be sent to another node …`** A call to
  an object owned by another tab, worker or peer carried one of them, as an argument or a result.
  They pass by reference only within one runtime ([docs/gaps.md](docs/gaps.md)).
- **`DataCloneError: Only ctx.exports.<name>({ props }) stubs and class handles can be stored.`** A
  Durable Object stub or an `RpcTarget` was put into storage; only `ctx.exports` handles with props
  are storable.
- **Writes after the last backup are gone after a crash** when the storage is a periodic backup
  alone (`filesApiBackup`). That is its RPO; a log (`celldBucket`, `filesApiLtxLog`) has none.

### Commands

Run from `packages/cellb` after `pnpm install` at the repository root.

| Command | What it does |
|---|---|
| `pnpm test` | `test/` and `e2e/` (vitest). The `e2e/` tests skip without `CELLD_BIN`; with it, each run makes its own S3 bucket (`TEST_BUCKET`) on `RUSTFS_ENDPOINT`, or starts a RustFS of its own on a free port when that is unset. Every server a test starts takes a free port, so several checkouts can run at once. `pnpm test:unit` and `pnpm test:e2e` run one folder. |
| `pnpm typecheck` | TypeScript for `src/`, `test/`, `e2e/` and the browser pages |
| `pnpm build` | `dist/` as published: `tsc -p tsconfig.build.json`, the hand-written declarations, worker URLs pointed at the compiled `.js` (`scripts/build.mjs`); `pnpm pack` runs it |
| `node scripts/pack-check.mjs` | the package as published: packs it, checks the packed manifest (no `workspace:`/`catalog:` specifier, export targets present, every import of `dist/` and `vendor/` declared), installs the tarball with npm outside the workspace and runs it from plain Node, TypeScript and a Vite app in Chromium (`PW_CHROMIUM` for the binary) |
| `pnpm e2e` | Chromium tests (Playwright, `e2e-browser/`), on a dev server at a free port, with the same bucket setup as `pnpm test`. Chromium is found from `PW_CHROMIUM`, then Playwright's own, then the one `@sparticuz/chromium` packages in `node_modules`. |
| `pnpm e2e:firefox`, `pnpm e2e:webkit` | the same suite in Playwright's Firefox or WebKit (`npx playwright install firefox webkit`; `PW_BROWSERS` takes a comma-separated list). What differs in Firefox: [docs/browser-host.md](docs/browser-host.md#firefox-and-webkit). |
| `pnpm interop` | `e2e/` and the celld conformance in Node: `scripts/interop-env.sh` downloads the pinned celld and RustFS into `~/.cache/cellb-interop`, starts a shared RustFS on `127.0.0.1:9200` (`RUSTFS_PORT`), and sets `CELLD_BIN`, `ESBUILD_DIR`, `RUSTFS_ENDPOINT` |
| `pnpm interop:browser` | the same for Chromium |
| `pnpm probes:browser` | the exploratory probes in Chromium (`e2e-browser/probes`), measurements printed, not part of `pnpm e2e`; among them the storage labs: `ltx-lab` (SQLite over a cell's LTX files; `LTX_STORE=worker`, `LTX_SYNC=1`) and `sqlite-lab` (SQLite in N workers, six storage modes). Add a spec name to run one |
| `pnpm bench:cluster` | celld nodes and `cellb serve` nodes on one RustFS bucket (needs `scripts/interop-env.sh`): throughput and latency of celld-only, CellB-only and mixed clusters, failover after a `SIGKILL`, a graceful leave. See [bench/README.md](bench/README.md#hybrid-clusters) |
| `pnpm bench`, `pnpm bench:browser` | the numbers celld.dev reports, measured for cellb: durability (one writer, acknowledged writes after a `SIGKILL`, durable write latency, failover), speed (stateless requests, waking a hibernated cell) and density (memory per resident cell), on Node and in Chromium. See [bench/README.md](bench/README.md); `bench/results/` holds the last recorded runs |
| `pnpm mutate`, `pnpm mutate:browser` | mutation harnesses in a throw-away copy, after a baseline run; `MUTANTS=0,3` runs a subset |
| `pnpm browser:dev` | the demo pages in `e2e-browser/pages`: `/` (one cell worker), `/sharded/`, `/backup/`, and `/host/`, the host app that runs a project folder |

### Releasing

Releases are made by CI, the same pipeline as the other statewalker monorepos
(`.github/workflows/ci.yml`). A change to the package carries a changeset (`pnpm changeset` at
the repository root); without one, the release planner (statewalker/statewalker-ci's
`scripts/release-changesets.mjs`) writes a patch for a package whose published contents changed.
On every push to `main`, after the `cellb` checks pass:

1. `version` applies the pending changesets in a "chore: version packages" pull request
   (versions, `CHANGELOG.md`). It never publishes. It opens the pull request with the
   `statewalker-release` GitHub App's token (organization variable `RELEASE_APP_CLIENT_ID`,
   secret `RELEASE_APP_KEY`), not `GITHUB_TOKEN`, so the checks run on it: GitHub does not run
   CI on what `GITHUB_TOKEN` pushes until a maintainer approves the run.
2. Once that pull request is merged, `pack` packs every public package whose version npm lacks
   (`pnpm pack`: `prepack` builds `dist/`, and `catalog:` ranges are resolved).
3. `publish` runs in the `npm` GitHub environment (only `main`, no approval) and publishes the
   tarballs at once with npm trusted publishing (OIDC, with provenance), creating a GitHub
   release per package. No npm token is stored in GitHub.

One-time setup on npm: `@statewalker/cellb` → Settings → Trusted publishing → GitHub Actions,
repository `statewalker/cellb.dev`, workflow `ci.yml`, environment `npm`. On GitHub: an
environment named `npm` whose deployment branch policy admits only `main`, with no required
reviewers. A new package's first version is published by
hand (`pnpm publish` in its directory, with the maintainer's 2FA), since a trusted publisher can
only be added to a package that exists.

The `cellb` job runs `node scripts/pack-check.mjs` before any of these: it checks exactly what
`publish` uploads. Run it locally to see the same.

## License

MIT. Vendored code keeps its own licence, named in each file's first line or a `LICENSE` beside it:
`vendor/celld/` and `conformance/celld-examples/` are Apache-2.0 (celld), `vendor/miniflare/` is
MIT OR Apache-2.0 (Miniflare) and Apache-2.0 (workerd's D1 client), `vendor/html-rewriter-wasm/` is
BSD-3-Clause, and `conformance/workerd-tests/` carry workerd's Apache-2.0.
