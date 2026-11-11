# Architecture

CellB is one runtime core that does not know where it runs, plus adapters for each platform. This
page shows the layers, the path of a request, and where each `src` directory sits. Words such as
*cell*, *owner* and *epoch* are defined in the [Glossary](../CONTEXT.md).

## One core, ports for everything that differs

```
            Worker module (export default { fetch } + Durable Object classes)
                                      │
   ┌──────────────────────────────────▼──────────────────────────────────┐
   │ core/        runtime, stubs, ids, object hosts, gates, SQL + KV, alarms │
   └───────┬───────────────┬───────────────┬───────────────┬────────────┘
           │ OpenCellSql   │ CellStorage   │ Lease          │ Clock
           ▼               ▼               ▼                ▼
   adapters/         bucket/  adapters/   bucket/ (celld     timers
   node:sqlite,      LTX log, changeset   ownership)
   SQLite WASM       log, backup
```

`src/core` reaches the platform only through the ports in `src/ports.ts`. Besides them it imports
isomorphic code of its own: the HTTP surface of a stub (`transport/cells-link`), the V8 value codec
(`v8/codec`) and the WebSocket upgrade over MessagePorts (`ws/server`, `ws/upgrade`). A platform
supplies:

| Port | What it is | Implementations |
|---|---|---|
| `OpenCellSql` → `SyncSqlDriver` | a synchronous SQLite database per cell | `nodeSqliteOpener` (node:sqlite), `sahpoolOpener` (SQLite WASM on OPFS), `wasmMemoryOpener` (SQLite WASM in memory), the LTX VFS (`bucket: { ltx }`: SQLite WASM reading a cell's LTX files page by page, [Running in a browser](browser-host.md)) |
| `CellStorage` | durability, backup, ownership and R2 objects, as one bundle the runtime closes | `celldBucket` (a fleet bucket), `filesApiLtxLog`, `filesApiChangeLog`; `filesApiBackup` for its `backup` part |
| `Lease` | per-cell ownership with an epoch and a "lost" signal | `celldBucket(...).ownership` |
| `ObjectStore` | a bucket with conditional writes | `s3ObjectStore`, `sqliteObjectStore` (celld dev's local store), `memoryObjectStore`, `filesApiObjectStore`, `idbObjectStore` (IndexedDB) |
| `Clock` | timers, injectable in tests | `systemClock` |
| `ValueCodec` | how KV values are stored | V8 serialization (the only codec) |

The SQL port is synchronous on purpose: `ctx.storage.sql.exec()` returns rows at once, as on
Cloudflare. Both drivers are synchronous underneath (node:sqlite, and the SQLite WASM `oo1` API in a
Dedicated Worker), so no async layer sits in between. The LTX VFS is the one exception inside:
its reads block the shard worker on a SharedArrayBuffer while a store worker reads the page.

A driver can implement `inTransaction()` (node:sqlite's `isTransaction`, SQLite WASM's
`sqlite3_get_autocommit`). After a failed statement, `SqlStorage` uses it to tell an ordinary
error from one that made SQLite roll back the whole transaction, such as an I/O error or a full
disk. If that transaction had only read, just the statement fails. If it had written, its commit
fails and the object resets, as on workerd.

## The path of a request

```
Request ─► runtime.fetch ─► Worker's fetch(req, env, ctx)
                                 │ env.COUNTER.getByName("a")      idFromName: synchronous
                                 ▼
                          stub ─► ObjectEndpoint ─┬─ local: ObjectHost.deliver ─► instance
                                                  ├─ route(): another shard (HTTP over a port)
                                                  └─ peers: the owner node (cells-http or celld's tunnel)
```

- `createCellRuntime(...).fetch(req)` is a plain `(Request) ⇒ Response` handler. A ServiceWorker, a
  `node:http` server or a test calls it the same way.
- A stub is a Proxy: `fetch` goes to the object's `fetch` handler, any other property is an RPC
  call. Plain values in arguments and results are cloned; functions, `RpcTarget`s and stubs pass by
  reference within one runtime, as on workerd (see [What breaks](#what-breaks) for other nodes).
- Every event for a cell goes through its object host's `deliver()`: the input gate, the implicit
  transaction, and the output gate wrap it (see [Ownership & durability](ownership-and-durability.md)).
- Everything a remote caller can do with a runtime is HTTP, served by one handler,
  `cellsHttpHandler(runtime)`. Internal requests carry `x-cellb*` control headers (`describe`,
  `fetch`, `rpc`); a request without them is ingress. `remoteRuntime(send)` is the client side of
  any `send: (Request) ⇒ Response`; `serveRuntime(port)` and `connectRuntime(port)` put it on a
  MessagePort with `@statewalker/webrun-rpc` and `@statewalker/webrun-http-streams`, so bodies
  stream.

## Loading a project

Most embedders start a project with `loadProject(source, options)`, which has the same name and
options in `@statewalker/cellb/node` and `@statewalker/cellb/browser`, and returns
`{ config, runtime, unsupported, fetch, close }`:

- **On Node**, `source` is a project folder (`wrangler.json(c)` and its `main`, bundled with
  esbuild), a folder written by `cellb build`, the URL of a built folder, or a FilesApi holding
  either. `data` is a directory for the cells (memory without it), `bucket` a fleet bucket.
- **In a browser**, in a Dedicated Worker, `source` is the URL of a folder written by `cellb build`
  or a FilesApi holding one. `data` names the OPFS pool. Loaded Workers get the package's own
  isolate worker unless `isolateScript: false` is passed.
- **`cellb build <project-dir> --out <dir>`** (or `buildProject` from `/node`) writes that folder
  on Node: `wrangler.json`, `worker.js` (`main` bundled for browsers), `assets/` and the
  `cellb.json` manifest, so that any static host can serve it.
- **`compile`: a `"bundle"` or a `"site"` compiler.** A browser can also load a project's sources
  from a FilesApi when `loadProject` is given one: `bundleCompiler({ esbuild })` from
  `@statewalker/cellb/bundle` (one ES module, built by webrun-bundler on esbuild-wasm), or
  `siteCompiler({ host })` from `@statewalker/cellb/site` (modules compiled one by one and served
  from a ServiceWorker). Without `compile`, a browser loads only `cellb build` folders.

Under `loadProject` are the lower-level calls of the next section: `loadNodeProject`,
`browserProjectRuntime` and, beneath both, `createProjectRuntime`. The shard functions of
`/browser` and `/tabs` (`startProjectShards`, `joinProjectShards`, `serveProjectShard`) run one
`browserProjectRuntime` per shard ([Running in a browser](browser-host.md)). The package
[README](../README.md) has the full list of options.

## Projects: a wrangler configuration becomes a runtime

`createProjectRuntime(config, module, host)` reads the subset of `wrangler.jsonc` that celld
deploys and builds the bindings: Durable Objects, KV, D1, R2, Queues, Workflows, assets, cron
triggers, Worker Loaders, Workers AI (on an OpenAI-compatible endpoint the host names) and service
bindings to the script's own entrypoints. It reports what it
does not support in `unsupported` instead of ignoring it. The hosts differ only in how they load
`main` and what they pass as `host`:

- `loadNodeProject(dir, host)` bundles `main` with esbuild and runs it in the Node process. Loaded
  Workers run in worker threads. The bundle's `cloudflare:workers` also exports the project's own
  `env` and `exports`, because code built for Cloudflare reads them at top level. While the module
  is evaluated they hold the configuration's `vars`, and once the runtime exists they hold its
  objects. A loaded Worker reads its own instead: its `WorkerCode.env` and stubs of its own
  entrypoints.
  `cloudflare:email` loads but cannot send. Under `nodejs_compat`, bare built-in names such as
  `path` resolve to Node's modules.
- `browserProjectRuntime(opts)` imports a browser bundle or modules served by the in-browser HTTP
  server. Loaded Workers run in Dedicated Workers when `opts.isolateScript` is set, and in the
  project's realm otherwise. See [Running in a browser](browser-host.md).

KV, Queues and Workflows run celld's own JavaScript, vendored in `vendor/celld/` unchanged apart
from an added export (KV) and a wrapping function (Queues, Workflows). D1 runs
Miniflare's D1 simulator with workerd's D1 client, vendored in `vendor/miniflare/`. See
[celld compatibility](celld-compatibility.md).

## Loaded Workers run in a realm of their own

A Worker Loader binding (`env.LOADER.get(id, () => code)`) runs each loaded Worker in its own isolate,
behind one MessagePort (`src/isolate/`): a worker thread in Node, always, and in a browser a
Dedicated Worker when the runtime has an `isolateScript`. The browser `loadProject` sets one by
default; `browserProjectRuntime` and the shard functions do not, and without it loaded Workers run
in the project's realm ([Security & isolation](security.md#which-entry-points-isolate-loaded-workers)).

- Plain values in its `env` are copied; anything that cannot be cloned (a stub, a binding) becomes a
  stub whose calls go back to the parent runtime.
- Calls cross the port with `@statewalker/webrun-rpc` (`callPort`/`listenPort` on a multiplexed
  port, with no timeout). An error thrown on one side arrives on the other with its own properties
  (`name`, `message`, `code`, …). A call returns an RpcPromise, and a call made on that result is
  sent at once, naming the pending answer (promise pipelining).
- A fetch into the isolate gets a port of its own and crosses as HTTP/1.1 with streamed bodies
  (the cells-http wire of `src/transport/port.ts`), so the first chunk of a response arrives while
  the loaded Worker is still producing the rest.
- Its modules are source (`js`), `text`, `json` or `wasm` bytes. A `data` module is refused, as
  celld refuses it, with `worker loader: module "x" must be a string or wasm bytes`.
- `globalOutbound: null` makes the isolate's `fetch` throw. A Fetcher redirects it instead: the
  isolate opens a fetch port back to the parent, which calls the Fetcher.
- Its `ctx.exports` holds its own `WorkerEntrypoint` classes. Each one can be used as a stub
  (`ctx.exports.Alt.greet()`) or called with `{ props }`. The props given to
  `getEntrypoint(name, { props })` reach `ctx.props` inside the isolate.
- Durable Object classes of loaded code (facets) run inside the isolate, with their own SQLite; their
  commits are logged through the parent's storage, in Node and in a browser. Under the root's lease
  the isolate rebuilds a facet's database from that storage when it opens, as the root does.
- The project's own Worker does **not** run in an isolate: it shares the host's realm.

## Where each directory sits

| Directory | Layer | What is in it |
|---|---|---|
| `src/core` | core | runtime, namespaces and stubs, ids, object hosts, input/output gates, SQL and KV storage, alarms, celld's internal schema |
| `src/ports.ts` | core | the port interfaces and `CellStorage` |
| `src/adapters` | platform | SQL drivers (node:sqlite, SQLite WASM, the WASM page hook, the LTX VFS), FilesApi logs and backups |
| `src/bucket` | storage | object stores (S3, SQLite, memory, FilesApi, IndexedDB), the LTX writer, `celldBucket` |
| `src/ltx` | storage | the LTX v3 codec (LZ4, CRC-64, xxHash32); page reads over a FilesApi, the streaming writer and compaction (`ltx-pages`); the store a VFS talks to (`ltx-page-server`, `ltx-store-worker`) and its OPFS files (`opfs-sync-files`) |
| `src/v8` | storage | V8 serialization in TypeScript, used on every platform (nothing imports `node:v8`) |
| `src/transport` | links | the HTTP surface (`cellsHttpHandler`, `remoteRuntime`) and links over ports |
| `src/router` | browser placement | `CellRouter` and the shard worker |
| `src/ws` | WebSockets | the WHATWG client, `WebSocketPair` (its ends are webrun-http-browser's `ServerWebSocket` with workerd's semantics) and the 101 `Response` over MessagePorts, the control channel |
| `src/project` | projects | wrangler loading for Node and browsers, the in-browser site, Workers globals (on Node also a workerd-like `MessageChannel`, whose idle ports do not keep the process alive), host modules for bundles made by other bundlers |
| `src/bindings` | projects | assets, cache, cron, D1 migrations, HTMLRewriter, KV, Queues, R2, Workflows, Worker Loader, Workers AI |
| `src/isolate` | projects | loaded Workers in their own realm (Node and browser) |
| `src/peer` | fleet | celld's peer protocol: a server for celld's requests and a client to reach celld owners (Node only) |
| `src/node-compat` | projects | `node:*` modules for `nodejs_compat` in browsers |
| `src/miniflare-compat` | projects | the shims that run Miniflare's vendored D1 simulator |

The package's exports (`package.json`) are three entry points, one per platform, and five more:

| Export | Source |
|---|---|
| `@statewalker/cellb` (isomorphic) | `src/index.ts` |
| `@statewalker/cellb/node` | `src/node.ts` |
| `@statewalker/cellb/browser` | `src/browser.ts` |
| `@statewalker/cellb/tabs` | `src/tabs.ts` |
| `@statewalker/cellb/site` | `src/site.ts` |
| `@statewalker/cellb/bundle` | `src/bundle.ts` |
| `@statewalker/cellb/host-modules` | `src/project/host-modules.ts` |
| `@statewalker/cellb/isolate-worker` | `src/isolate/isolate-worker.ts` |

Importing the isomorphic entry point loads no `node:` module, and a test checks that.

## What breaks

- **A function, `RpcTarget` or stub sent to an object on another node is refused** with
  `DataCloneError: Functions, RpcTargets and stubs cannot be sent to another node: …`. Within one
  runtime, and into or out of a loaded Worker's isolate, they pass by reference, as on workerd
  (celld refuses them). See [Gaps](gaps.md#stubs-pass-by-reference-as-on-workerd-except-between-nodes).
- **The project's own Worker sees the host's globals.** Only loaded Workers are isolated; code that
  writes to `globalThis` in the main Worker affects the whole runtime.
- **A public endpoint mounted on `cellsHttpHandler` lets clients address any object directly** with
  `x-cellb*` headers. Mount `runtime.fetch` (or `CellRouter.ingress`, which strips the headers) on
  public ingress, and `cellsHttpHandler` only on internal links.
- **A request loses its `Upgrade` header.** `Upgrade` is hop-by-hop on the HTTP/1.1 wire and a
  forbidden header in browser `Request`s, so across links it travels as `x-cellb-upgrade`. A link that
  rebuilds requests without `withUpgrade` hands the Worker a plain request, and the Worker answers
  it as one (typically `426 Upgrade Required`) instead of opening a WebSocket.
