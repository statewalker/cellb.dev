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

The package has three entry points, one per platform. Its sources are TypeScript (there is no build
step yet), so import it through a bundler, Vite or vitest.

| Import | What it gives |
|---|---|
| `@statewalker/cellb` | the runtime (`createCellRuntime`, `createProjectRuntime`), `DurableObject` and `WorkerEntrypoint`, the ports and `CellStorage`, `celldBucket`, the object stores (`s3ObjectStore`, `memoryObjectStore`, `filesApiObjectStore`), `filesApiLtxLog`, `filesApiChangeLog`, `filesApiBackup`, `wasmMemoryOpener` (in-memory SQLite WASM), links over ports, `CellRouter`, `createShardWorker`, the WebSocket classes, and the errors embedders catch |
| `@statewalker/cellb/node` | `nodeSqliteOpener`, `sqliteObjectStore` (celld dev's local bucket), `loadNodeProject`, `applyNodeD1Migrations`, and celld's peer protocol (`startCelldPeerServer`, `celldPeers`) |
| `@statewalker/cellb/browser` | `browserProjectRuntime`, `sahpoolOpener`, `createProjectSite`, `serviceWorkerConnector` |

Node 22.13 or later is needed for `node:sqlite`. `loadNodeProject` bundles a project with
`esbuild`, which the embedder must install.

A runtime is a `(Request) ⇒ Response` handler: mount `runtime.fetch` on `node:http`, a
ServiceWorker or a test, and call `runtime.close()` when done. `close()` takes final backups,
closes every database, then closes the storage.

## Examples

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

### A wrangler project on a bucket shared with celld

```ts
import { celldBucket } from "@statewalker/cellb";
import { loadNodeProject, nodeSqliteOpener, sqliteObjectStore } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const dir = "./counter"; // wrangler.jsonc and its `main`
const { runtime, unsupported } = await loadNodeProject(dir, {
  openSql: nodeSqliteOpener(), // in memory: every cell is restored from the bucket on first use
  files: new MemFilesApi(), // blob store for large KV values
  storage: celldBucket(sqliteObjectStore(`${dir}/.celld/dev/objects.sqlite3`), { node: "cellb-1" }),
});
console.log(unsupported); // configuration entries cellb does not support, e.g. []
await runtime.fetch(new Request("http://localhost/increment?name=a"));
await runtime.close(); // releases the cells, so celld can take them at once
```

`sqliteObjectStore` is the bucket `celld dev` keeps in that file. A fleet on S3 uses
`s3ObjectStore({ endpoint, bucket, prefix, region, accessKeyId, secretAccessKey })` instead.

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
src/adapters        node:sqlite and SQLite WASM drivers, the WASM page hook, FilesApi logs and backups
src/bucket          object stores (S3, SQLite, memory, FilesApi), the LTX writer, celldBucket
src/ltx             the LTX v3 codec (LZ4, CRC-64, xxHash32)
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
                    shard workers they drive; probes/ the exploratory browser probes (ServiceWorker idling)
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
- **celld judges conformance**, because cellb's storage must be celld's; workerd is recorded only
  to pin where celld differs ([docs/conformance.md](docs/conformance.md)).
- **The gates use no `AsyncLocalStorage`**, which browsers lack.
- **A browser origin has a fixed number of shards**, because an OPFS pool is exclusive per worker
  ([docs/browser-host.md](docs/browser-host.md)).
- **WebSockets travel over MessagePorts**, because a ServiceWorker cannot accept them.
- **Each loaded Worker gets a realm of its own**, a thread or a Dedicated Worker: as in celld's
  isolates, loaded code must not see the host's globals or env.
- **`idFromName` is synchronous**, with `@noble/hashes` instead of `crypto.subtle`, which is
  asynchronous only; Worker code relies on getting the id at once.
- **Ownership depends on the deployment**: a Web Lock per shard in an origin, celld's ownership
  records per cell on a fleet bucket
  ([docs/ownership-and-durability.md](docs/ownership-and-durability.md)).

What cellb does not do yet is in [docs/gaps.md](docs/gaps.md); how it matches celld is in
[docs/celld-compatibility.md](docs/celld-compatibility.md). The vocabulary is in
[CONTEXT.md](CONTEXT.md).

### Dependencies, and why

- `@sqlite.org/sqlite-wasm` — SQLite in browsers (opfs-sahpool needs no COOP/COEP headers);
  `sqlite-vec` for celld's `sqlite_vec` flag.
- `@noble/hashes` — synchronous SHA-256 and HMAC for object ids.
- `@statewalker/webrun-rpc`, `webrun-http-streams`, `webrun-streams` — HTTP with streaming bodies
  over MessagePorts.
- `@statewalker/webrun-files` — the FilesApi for logs, backups and KV blobs;
  `webrun-http-browser`, `webrun-site-builder`, `webrun-site-host` — ServiceWorker ingress and the
  in-browser HTTP server.
- `worker-timers` — unthrottled heartbeat timers on a page's main thread.
- `buffer`, `events`, `util`, `assert`, `path-browserify` — `nodejs_compat` in browsers.

### What will surprise you

- **`ERR_MODULE_NOT_FOUND` for `…/src/…/*.js` when importing with plain `node`.** The entry points
  are TypeScript sources; import them through a bundler, Vite or vitest.
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
- **`RPC stubs cannot cross isolate boundaries yet.`** An `RpcTarget` was passed through a stub.
  celld refuses it too ([docs/gaps.md](docs/gaps.md)).
- **Writes after the last backup are gone after a crash** when the storage is a periodic backup
  alone (`filesApiBackup`). That is its RPO; a log (`celldBucket`, `filesApiLtxLog`) has none.

### Commands

Run from `packages/cellb` after `pnpm install` at the repository root.

| Command | What it does |
|---|---|
| `pnpm test` | `test/` and `e2e/` (vitest). The `e2e/` tests skip without `CELLD_BIN`; with it, each run makes its own S3 bucket (`TEST_BUCKET`) on `RUSTFS_ENDPOINT`, or starts a RustFS of its own on a free port when that is unset. Every server a test starts takes a free port, so several checkouts can run at once. `pnpm test:unit` and `pnpm test:e2e` run one folder. |
| `pnpm typecheck` | TypeScript for `src/`, `test/`, `e2e/` and the browser pages |
| `pnpm e2e` | Chromium tests (Playwright, `e2e-browser/`), on a dev server at a free port, with the same bucket setup as `pnpm test`. Chromium is found from `PW_CHROMIUM`, then Playwright's own, then the one `@sparticuz/chromium` packages in `node_modules`. |
| `pnpm interop` | `e2e/` and the celld conformance in Node: `scripts/interop-env.sh` downloads the pinned celld and RustFS into `~/.cache/cellb-interop`, starts a shared RustFS on `127.0.0.1:9200` (`RUSTFS_PORT`), and sets `CELLD_BIN`, `ESBUILD_DIR`, `RUSTFS_ENDPOINT` |
| `pnpm interop:browser` | the same for Chromium |
| `pnpm mutate`, `pnpm mutate:browser` | mutation harnesses in a throw-away copy, after a baseline run; `MUTANTS=0,3` runs a subset |
| `pnpm browser:dev` | the demo pages in `e2e-browser/pages`: `/` (one cell worker), `/sharded/`, `/backup/`, and `/host/`, the host app that runs a project folder |

## License

MIT. Vendored code keeps its own licence, named in each file's first line or a `LICENSE` beside it:
`vendor/celld/` and `conformance/celld-examples/` are Apache-2.0 (celld), `vendor/miniflare/` is
MIT OR Apache-2.0 (Miniflare) and Apache-2.0 (workerd's D1 client), `vendor/html-rewriter-wasm/` is
BSD-3-Clause, and `conformance/workerd-tests/` carry workerd's Apache-2.0.
