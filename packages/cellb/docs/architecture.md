# Architecture

cellb is one runtime core that does not know where it runs, plus adapters for each platform. This
page shows the layers, the path of a request, and where each `src` directory sits. Words such as
*cell*, *owner* and *epoch* are defined in [CONTEXT.md](../CONTEXT.md).

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
| `OpenCellSql` → `SyncSqlDriver` | a synchronous SQLite database per cell | `nodeSqliteOpener` (node:sqlite), `sahpoolOpener` (SQLite WASM on OPFS), `wasmMemoryOpener` (SQLite WASM in memory) |
| `CellStorage` | durability, backup, ownership and R2 objects, as one bundle the runtime closes | `celldBucket` (a fleet bucket), `filesApiLtxLog`, `filesApiChangeLog`; `filesApiBackup` for its `backup` part |
| `Lease` | per-cell ownership with an epoch and a "lost" signal | `celldBucket(...).ownership` |
| `ObjectStore` | a bucket with conditional writes | `s3ObjectStore`, `sqliteObjectStore` (celld dev's local store), `memoryObjectStore`, `filesApiObjectStore` |
| `Clock` | timers, injectable in tests | `systemClock` |
| `ValueCodec` | how KV values are stored | V8 serialization (the only codec) |

The SQL port is synchronous on purpose: `ctx.storage.sql.exec()` returns rows at once, as on
Cloudflare. Both drivers are synchronous underneath (node:sqlite, and the SQLite WASM `oo1` API in a
Dedicated Worker), so no async layer sits in between.

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
  call. Arguments and results are structured-cloned, as between isolates.
- Every event for a cell goes through its object host's `deliver()`: the input gate, the implicit
  transaction, and the output gate wrap it (see [ownership-and-durability.md](ownership-and-durability.md)).
- Everything a remote caller can do with a runtime is HTTP, served by one handler,
  `cellsHttpHandler(runtime)`. Internal requests carry `x-cellb*` control headers (`describe`,
  `fetch`, `rpc`); a request without them is ingress. `remoteRuntime(send)` is the client side of
  any `send: (Request) ⇒ Response`; `serveRuntime(port)` and `connectRuntime(port)` put it on a
  MessagePort with `@statewalker/webrun-rpc` and `@statewalker/webrun-http-streams`, so bodies
  stream.

## Projects: a wrangler configuration becomes a runtime

`createProjectRuntime(config, module, host)` reads the subset of `wrangler.jsonc` that celld
deploys and builds the bindings: Durable Objects, KV, D1, R2, Queues, Workflows, assets, cron
triggers, Worker Loaders and service bindings to the script's own entrypoints. It reports what it
does not support in `unsupported` instead of ignoring it. The hosts differ only in how they load
`main` and what they pass as `host`:

- `loadNodeProject(dir, host)` bundles `main` with esbuild and runs it in the Node process; loaded
  Workers run in worker threads. The bundle's `cloudflare:workers` also exports the project's own
  `env` and `exports` (the configuration's `vars` while the module is evaluated, the runtime's
  objects once it exists), as code built for Cloudflare reads them at top level; a loaded Worker's
  reads its own (its `WorkerCode.env`, and stubs of its own entrypoints), and gets the Workers
  globals of its own compatibility flags, in its thread too; `cloudflare:email`
  loads but cannot send; under `nodejs_compat`, bare built-in names (`path`) are Node's modules.
- `browserProjectRuntime(opts)` imports a browser bundle or modules served by the in-browser HTTP
  server; loaded Workers run in Dedicated Workers. See [browser-host.md](browser-host.md).

KV, Queues and Workflows run celld's own JavaScript, vendored unchanged in `vendor/celld/`. D1 runs
Miniflare's D1 simulator with workerd's D1 client, vendored in `vendor/miniflare/`. See
[celld-compatibility.md](celld-compatibility.md).

## Loaded Workers run in a realm of their own

A Worker Loader binding (`env.LOADER.get(id, () => code)`) runs each loaded Worker in its own isolate:
a worker thread in Node, a Dedicated Worker in a browser, behind one MessagePort (`src/isolate/`).

- Plain values in its `env` are copied; anything that cannot be cloned (a stub, a binding) becomes a
  stub whose calls go back to the parent runtime.
- Calls cross the port with `@statewalker/webrun-rpc` (`callPort`/`listenPort` on a multiplexed
  port, no timeout); an error thrown on one side arrives on the other with its own properties
  (`name`, `message`, `code`, …). A call's result is an RpcPromise: a call on it is sent at once,
  naming the pending answer (promise pipelining).
- A fetch into the isolate gets a port of its own and crosses as HTTP/1.1 with streamed bodies
  (the cells-http wire of `src/transport/port.ts`): the first chunk of a response arrives while the
  loaded Worker is still producing the rest.
- Its modules are source (`js`), `text`, `json` or `wasm` bytes. A `data` module is refused, as
  celld refuses it: `worker loader: module "x" must be a string or wasm bytes`.
- `globalOutbound: null` makes the isolate's `fetch` throw; a Fetcher redirects it: the isolate
  opens a fetch port back to the parent, which calls the Fetcher.
- Its `ctx.exports` holds its own `WorkerEntrypoint` classes, each a stub
  (`ctx.exports.Alt.greet()`) or called with `{ props }`; `getEntrypoint(name, { props })` props
  reach `ctx.props` inside the isolate.
- Durable Object classes of loaded code (facets) run inside the isolate, with their own SQLite; their
  commits are logged through the parent's storage, in Node and in a browser. Under the root's lease
  the isolate rebuilds a facet's database from that storage when it opens, as the root does.
- The project's own Worker does **not** run in an isolate: it shares the host's realm.

## Where each directory sits

| Directory | Layer | What is in it |
|---|---|---|
| `src/core` | core | runtime, namespaces and stubs, ids, object hosts, input/output gates, SQL and KV storage, alarms, celld's internal schema |
| `src/ports.ts` | core | the port interfaces and `CellStorage` |
| `src/adapters` | platform | SQL drivers (node:sqlite, SQLite WASM, the WASM page hook), FilesApi logs and backups |
| `src/bucket` | storage | object stores (S3, SQLite, memory, FilesApi), the LTX writer, `celldBucket` |
| `src/ltx` | storage | the LTX v3 codec: LZ4, CRC-64, xxHash32 |
| `src/v8` | storage | V8 serialization in TypeScript, for platforms without `v8.serialize` |
| `src/transport` | links | the HTTP surface (`cellsHttpHandler`, `remoteRuntime`) and links over ports |
| `src/router` | browser placement | `CellRouter` and the shard worker |
| `src/ws` | WebSockets | the WHATWG client, `WebSocketPair` and the 101 `Response` over MessagePorts, the control channel |
| `src/project` | projects | wrangler loading for Node and browsers, the in-browser site, Workers globals |
| `src/bindings` | projects | assets, cache, cron, D1 migrations, HTMLRewriter, KV, Queues, R2, Workflows, Worker Loader |
| `src/isolate` | projects | loaded Workers in their own realm (Node and browser) |
| `src/peer` | fleet | celld's peer protocol: a server for celld's requests and a client to reach celld owners (Node only) |
| `src/node-compat` | projects | `node:*` modules for `nodejs_compat` in browsers |
| `src/miniflare-compat` | projects | the shims that run Miniflare's vendored D1 simulator |

The three entry points select by platform: `src/index.ts` (isomorphic), `src/node.ts`,
`src/browser.ts`. Importing the isomorphic entry point loads no `node:` module; a test guards that.

## What breaks

- **A stub call with a class instance that extends `RpcTarget` fails** with `RPC stubs cannot cross
  isolate boundaries yet.` Functions pass by reference inside one runtime; `RpcTarget` does not. This
  matches celld. See [gaps.md](gaps.md).
- **A loaded Worker gets a function or stub as an RPC argument and throws `DataCloneError`.** Across
  an isolate, only `env` entries become stubs; arguments, results and `props` are structured-cloned.
- **The project's own Worker sees the host's globals.** Only loaded Workers are isolated; code that
  writes to `globalThis` in the main Worker affects the whole runtime.
- **A public endpoint mounted on `cellsHttpHandler` lets clients address any object directly** with
  `x-cellb*` headers. Mount `runtime.fetch` (or `CellRouter.ingress`, which strips the headers) on
  public ingress, and `cellsHttpHandler` only on internal links.
- **A request whose `Upgrade` header vanished.** `Upgrade` is hop-by-hop on the HTTP/1.1 wire and a
  forbidden header in browser `Request`s; across links it travels as `x-cellb-upgrade`. A link that
  rebuilds requests without `withUpgrade` hands the Worker a plain request, and the Worker answers
  it as one (typically `426 Upgrade Required`) instead of opening a WebSocket.
