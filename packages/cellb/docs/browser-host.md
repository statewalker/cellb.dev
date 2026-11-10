# Running cells in a browser

A browser has no server process, no `node:sqlite` and no way for a ServiceWorker to accept a
WebSocket. CellB still runs a project's Workers and Durable Objects there. It keeps SQLite WASM on
OPFS in a Dedicated Worker, routes requests through a ServiceWorker and carries WebSockets over
MessagePorts. This page covers the four ways to wire it, the S3 setup for a fleet bucket, what
fails, and what differs in Firefox and WebKit.

## What a browser forces

- **Synchronous SQLite needs a Dedicated Worker.** OPFS synchronous access handles exist only there.
  `sahpoolOpener` (the opfs-sahpool VFS) needs no COOP/COEP headers, so any static host works.
- **An opfs-sahpool pool is exclusive.** A second worker opening the same pool name fails with
  `NoModificationAllowedError`, so each worker gets its own pool.
- **An opfs-sahpool pool has a fixed number of files until it grows**, and growing is asynchronous
  while opening a database is not. `sahpoolOpener` gives the runtime `room(cellKey)`, and a cell's
  first event waits until the pool has room for it. It reserves three files per cell: the database,
  its journal and a spare. The pool also grows in the background whenever less than half of it is
  free.
- **One worker's cells share one SQLite heap of at most 2 GiB, which never shrinks.** Each open
  cell takes about 120 KiB of it, with lookaside turned off and 4 KiB pages for a new database.
  That allows about 20,000 small cells open in one worker, as measured in Chromium (see
  [Cells per browser](browser-capacity.md)). The memory of a closed database is reused by the
  next one opened, and `closeDatabaseAfterMs` closes idle cells' databases, so the heap does not
  limit how many cells a worker keeps on disk. A worker that ends gives its heap back.
- **One worker is one thread.** Its cells interleave, and their SQLite I/O runs on that thread. For
  parallel work, spread the project over several workers (next section).
- **Journals stay in the pool.** `sahpoolOpener` opens databases with `journal_mode=PERSIST`, so
  the rollback journal keeps its pool slot between commits instead of being created and deleted on
  each one. The database file is the same as with the default `DELETE`; only WAL changes it.
- **`AsyncLocalStorage` needs help.** Browsers have no async context yet. For a nodejs_compat
  project, `browserProjectRuntime` makes promise and timer continuations carry their stores, and
  the code's `await` is lowered so that it goes through them. `bundleWorkerForBrowser` does the
  lowering for a bundle, and `createProjectSite` does it for a site's modules ([Gaps](gaps.md)).
  In a browser with TC39 AsyncContext neither is needed: `node:async_hooks` runs on it directly,
  and a site lowers nothing.
- **A ServiceWorker cannot spawn workers** and is stopped when idle, dropping every port it held.
  It can route requests, hold Web Locks and pass MessagePorts. So the ServiceWorker routes, and a
  page owns the workers.
- **A ServiceWorker cannot intercept WebSockets.** Pages and objects get a WebSocket class whose
  frames travel over MessagePorts. The class, the frames, the HTTP links over ports and the
  dispatcher behind the tabs' router (`installProjectRouter`) come from
  `@statewalker/webrun-http-browser`. CellB adds the router's URLs, its shard routing, the page's
  cookies and the host page.
- **Without an open page nothing runs.** No page means no Dedicated Worker and no SQLite. Cells
  that must stay reachable live on a fleet bucket that server nodes share.

## Four topologies

### A project in one worker: `browserProjectRuntime`

```
page ── fetch("/app/…") ──► ServiceWorker (webrun-http-browser)
                              │ forwards to the page's handler
                              ▼
                       Dedicated Worker: browserProjectRuntime({ config, code, sqlite3, pool, filesDir, bucket? })
                         cells: SQLite WASM in OPFS pool `pool` · files: OPFS `filesDir`
                         loaded Workers: one Dedicated Worker each (isolateScript)
                         bucket: a celld fleet bucket (S3, OPFS or any ObjectStore)
```

`browserProjectRuntime` installs the Workers globals (`Response` that accepts status 101, a
`Request` whose copies keep an upgrade's headers, `WebSocket`, `WebSocketPair`, `caches`,
`HTMLRewriter`, and `Buffer`/`process` for `nodejs_compat`), imports the
code and builds the runtime from the wrangler configuration. The code is either:

- `{ bundle }` — one ES module built for browsers, whose `cloudflare:workers` import and Workers
  globals read what the runtime installs. `bundleWorkerForBrowser(entry, { nodeCompat })` from
  `@statewalker/cellb/node` builds it: `cloudflare:workers` with the project's own `env` and
  `exports`, `cloudflare:email`, and with nodejs_compat the `node:*` polyfills (bare names such as
  `"path"` too). A Flue app built for Cloudflare runs this way (examples/flue).
- `{ site }` — the base URL of an in-browser HTTP server made by `createProjectSite` (from
  `@statewalker/cellb/site`) and hosted by `@statewalker/webrun-site-host`, which compiles the
  project's sources on request (`@statewalker/webrun-modules`). These are optional peer
  dependencies, so install them if you build sites. Loaded Workers' code is uploaded to the site
  and imported from URLs. The project's `cloudflare:workers` has its own `env` and `exports`, and
  `cloudflare:email` loads. Workers loaded into the project's realm get empty `env` and `exports`;
  in isolates they get their own. With `nodeCompat` the site lowers `await` in the modules it
  serves, so `AsyncLocalStorage` behaves as in a bundle. The site's `nodeCompat` must match the
  project's flag (see below).

A loaded Worker's `cloudflare:workers` has its own `env` and `exports` (its `WorkerCode.env`, and
stubs of its own entrypoints), except on a site without `isolateScript`.
With `isolateScript`, each loaded Worker runs in its own Dedicated Worker. Without it, it runs in
this worker's realm. The package ships that worker as `@statewalker/cellb/isolate-worker`. With
Vite, `import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url"` and pass
`isolateScript: new URL(isolateWorker, import.meta.url)`.

The host app in `e2e-browser/pages/host` uses this topology. Run `pnpm browser:dev` and open
`/host/`, then pick a project folder, a node name and a bucket, and the project is served at its
own URL.

### A project over several workers: `startProjectShards`

```
page: startProjectShards({ shards: 4, spawn, config, code, name })  → { fetch, shards, close }
        │ ingress, round robin
        ▼
worker i: serveProjectShard({ sqlite3 })
            browserProjectRuntime(…, pool `<name>-i`, route)
            owns the cells with shardOf(id, 4) === i; other cells → worker shardOf(id) over a port
```

Each worker hosts the whole project with its own OPFS pool and owns the cells `shardOf` gives
it. A Durable Object call from any worker runs in the owner's worker, so cells run in parallel
threads. Any worker takes ingress (the Worker's `fetch`), and `fetch` spreads requests over them.
The worker script is one line:

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";
serveProjectShard({ sqlite3: () => sqlite3InitModule({ print() {}, printErr() {} }) });
```

- Placement is fixed by a hash of the cell id. A few dozen cells spread unevenly, and nothing
  rebalances them.
- The workers belong to the page, and closing it stops them. To share them between tabs, use the
  next topology.
- `browserProjectRuntime({ route })` is the building block: any placement that maps a cell to the
  worker hosting it works the same way.

### A project shared by the tabs: `joinProjectShards` and `installProjectRouter`

```
ServiceWorker: installProjectRouter(self, { basePath: "/app/" })
  a webrun-http-browser dispatcher; the key of a request is its project's name
  /app/<name>/…                    ─► the live shard with the fewest requests in flight
  http://cellb.internal/<name>/    ─► the shard the sender named (x-cellb-shard), shard → shard

every tab: joinProjectShards({ name, shards: 4, spawn, config, code, serviceWorker })
  presence lock  cellb:<name>:tab:<joined-at>-<uuid>
  shard i        → tab (i mod n) of the n tabs present, oldest first; one Web Lock per shard
  shard worker:  serveProjectShard({ sqlite3 }) — pool <name>-shard-i, attached to the router
                 (SwHttpAdapter.attachWorker, serveHttpInWorker)
```

The tab and the ServiceWorker import both functions from `@statewalker/cellb/tabs`, and the
shard worker imports `serveProjectShard` from `@statewalker/cellb/browser`. The `tabs` entry holds
only the routing code (about 75 KB minified with Vite, most of it webrun-http-browser's router),
not the runtime the shards run. `@statewalker/cellb/browser` exports the same two functions, but
a page
that imports them from there bundles that runtime too.

`installProjectRouter` starts webrun-http-browser's dispatcher, which makes the ServiceWorker
`skipWaiting()` on install and `clients.claim()` on activate. A new version therefore takes over
the open pages at once instead of waiting for them to close. A tab that joins must be inside the
ServiceWorker's scope and controlled by it. A tab that is not gets claimed, and
`joinProjectShards` rejects with a `ServiceWorkerControlError` if that has not worked within 30 s
(after a hard reload, for example). A request to a project no tab has ever served goes to the
network as the page sent it. A request to a project whose tabs have all closed gets a 503.

Every tab of the origin sends requests to `<basePath><name>/…`. The ServiceWorker passes them to a
shard worker, wherever it runs, with their URL unchanged, as a Worker on a Cloudflare route sees
them. With `stripBase: true` the Worker sees `/…` instead. The tabs split the shards evenly: each
tab computes the same owners from the tabs present and takes its own. A project of 4 shards runs
all 4 in one tab, 2 / 2 in two tabs and 2 / 1 / 1 in three, so more tabs bring more processes and
more cores.

- **A tab joins or leaves (`close()`):** the shards whose owner changes are handed over. The router
  stops sending the shard new requests (they wait for the next owner), lets the ones in flight
  finish for up to `drainMs` (5 s). Then the old worker closes its runtime and gives up its OPFS
  pool, and the next owner opens the same pool, so the cells move with the shard. An open
  long-poll or SSE stream keeps the drain waiting for the full `drainMs`. Before it closes, the old worker
  closes its sockets with `1001` (going away), so their clients reconnect to the next owner at
  once instead of noticing through the heartbeat.
- **Pages open sockets** with `createWebSocketClass(serviceWorkerConnector(serviceWorker))`: the
  ServiceWorker routes the upgrade to a shard worker and hands the page the socket's port. From
  then on the socket runs directly between the page and the shard worker, so it survives a
  restart of the ServiceWorker.
- **A tab closes or crashes:** it runs no more code. Its locks are released, and the router sees
  each shard worker's own lock go and fails the requests in flight there with
  `ShardOwnerLostError`. The other tabs take the shards over within `checkMs` (1 s).
- **The ServiceWorker restarts:** it asks the tabs for their shards' links again. The browser stops
  an idle ServiceWorker, and its ports die without telling anyone. A request to it starts it
  again, but a call that begins in a shard (an alarm, a timer, a WebSocket message) to an object
  in another shard does not. webrun-http-browser handles both: the router holds a Web Lock while
  it lives, which each shard watches; a shard whose router is gone wakes the ServiceWorker through
  its tab, and its next call goes through once the links are back. A call already in flight when
  the ServiceWorker stopped has lost its answer: it fails ("The router was lost while this call
  was in flight"), and may or may not have been applied. To make that rare, a shard with calls
  into other shards in flight keeps the ServiceWorker up. Those calls travel over MessagePorts, so
  the ServiceWorker sees no events from them, and Chromium stops a ServiceWorker after about 30 s
  without events. The ServiceWorker can still stop for other reasons (an update, a crash, memory
  pressure), so this failure remains possible.
- **Tests of the idle timeout need a Chromium without Playwright's DevTools sessions.** Playwright
  attaches one to every ServiceWorker, which keeps it running. `e2e-browser/raw-chromium.ts` drives
  a separate Chromium over CDP, attached to its pages only.
- Placement inside the project is still by cell id (`shardOf`), so a few dozen cells spread
  unevenly.
- With `bucket`, each shard is a fleet node named `<node>-s<i>`. Use S3 here, because an OPFS
  bucket allows only one writer at a time.

#### Cells in memory, persisted in IndexedDB: `bucket: { idb, node }`

With `bucket: { idb: "<database>", node }`, a shard runs each cell's SQLite in memory and
persists it through the bucket's page-level logs (LTX) in IndexedDB, whose conditional writes
are atomic across tabs and workers. No OPFS SyncAccessHandle is opened, so nothing is exclusive
to one worker. In [examples/astro-in-browser](../../../examples/astro-in-browser)
(`cells-lab.spec.ts`: 48 cells with 10 writes each, then a reload), 8 shards took 5.1 s against
9.1 s with OPFS pools, and 16 shards took 5.3 s against 8.9 s. Every cell read back after the
reload. Reads after a restart are slower because they replay the log (1.4–2.2 s against
0.6–0.9 s). The example runs as a [live demo](https://cellb-astro.httpeers.net).

#### Cells on LTX files in OPFS: `bucket: { ltx, node }`

With `bucket: { ltx: "<directory>", node }`, a shard keeps each cell the way celld does: a
snapshot and one LTX file per commit, in an OPFS directory with celld's layout
(`cells/<Class>:<idHex>/ltx/e1/0000/<min>-<max>.ltx`). SQLite never holds the whole database. It
reads pages through a VFS, so a cell's memory is its page cache, whatever the cell's size.

```
shard worker                                          LTX store worker (one per shard)
  SQLite WASM ─ ltx VFS (src/adapters/ltx-vfs.ts)        ltxCellStore (src/ltx/ltx-page-server.ts)
     xRead ──► page cache (LRU, 2048 pages) ─ miss ──►     readRun: one range read per file
     xSync ──► the transaction's pages ───────────────►    commit: one LTX file, appended
     blocked on a SharedArrayBuffer (Atomics.wait)  ◄──    answer written into the buffer
                                                         opfsSyncFiles (src/ltx/opfs-sync-files.ts)
                                                           SyncAccessHandles in <directory>
```

- **Reads.** A page miss asks the store for a run of 16 pages (read-ahead), and the store reads
  each file the run touches once, by range. A file is opened by its header and page index only
  (`src/ltx/ltx-pages.ts`).
- **Commits.** The journal is in memory (`journal_mode=MEMORY`). At `xSync` the transaction's
  pages become one LTX file, written under a temporary name and moved into place, so no reader
  sees a partial file.
- **Compaction.** Once a cell has `compactAfter` files (default 64), or once the files after the
  snapshot hold more than half of it (and at least 1 MiB), the store writes a new snapshot beside
  the old files. It streams the snapshot, so only a run of pages and the index are in memory, and
  swaps the files between two requests. The swap moves the snapshot into place first and then
  removes the files it replaces, so a swap cut short (a closed tab, a lost connection) leaves a
  cell that opens from the snapshot, and the next open removes the leftovers. It checks the free
  space first (on OPFS, the origin's estimate) and skips the compaction if there is no room for
  the new snapshot.
- **One writer per cell.** The store holds a Web Lock per cell, named after the directory and
  the cell, while the cell is open. A store that wants a cell held by another tab or worker waits
  up to 20 s, since on a reload the previous page lets go a moment later. Then it fails the
  request.
- **Needs cross-origin isolation** for SharedArrayBuffer. That means COOP/COEP headers, which a
  ServiceWorker can add, as examples/astro-in-browser does.
- `files: "opfs"` uses OPFS's asynchronous API instead of synchronous handles. `"memory"` keeps
  nothing and is meant for tests.

EmDash's site and its package store run on it in
[examples/astro-in-browser](../../../examples/astro-in-browser) ([live demo](https://cellb-astro.httpeers.net)). A 64 MiB cell
compacts with about 4 MB in memory (`test/p30-ltx-pages.test.ts`).

##### On the app's own FilesApi

The cells' files can live on any FilesApi the app opens **before** it starts the shard workers:
a folder on the user's disk (File System Access), memory, OPFS, a key/value store, S3… A FilesApi
instance cannot be posted to a worker, so the app hands it over in one of three ways
(`filesApiPort`, `serveLtxStore` and `serveFilesApi` are exported from `@statewalker/cellb/browser`):

```ts
const files = await openBrowserFilesApi({ /* showDirectoryPicker, a handle kept in IDB */ });

// 1. The FilesApi stays where the app opened it, served over a port; the shard's store worker
//    runs the store (LZ4, compaction) and calls the FilesApi by message. A port is used up by
//    one runtime: a new `filesApiPort` per shard worker (and per restart of one).
const { port } = filesApiPort(files);
shard.postMessage({ bucket: { ltx: "my-project", node, files: { port } } }, [port]);

// 2. The store itself runs here, on the instance (no FilesApi messages); the shard's VFS sends
//    it its reads and commits. Its work (LZ4, compaction) then shares this thread. One store
//    per shard worker; `await store.close()` when the worker ends, or its successor's store
//    waits 20 s for the cells' Web Locks and then fails.
const store = serveLtxStore(files, { lockScope: "my-project" });
shard.postMessage({ bucket: { ltx: "my-project", node, ltxStore: { sab: store.sab, port: store.port } } }, [store.port]);

// 3. The store worker builds the FilesApi itself from a module and cloneable arguments (an
//    FSA directory handle, S3 settings): `export default (args) => FilesApi`, and optionally
//    `export function room(args)` for its free bytes. The URL must load as is in a worker: a
//    self-contained ES module (bundled with its imports, e.g. served from `public/`).
bucket: { ltx: "my-project", node, files: { module: "/my-files.js", args } }
```

A bundler does not process the module of way 3: Vite, for one, copies
`new URL("./my-files.js", import.meta.url)` as an asset, bare imports and all, which the worker
then cannot resolve. Bundle that module on its own, or use way 1.

`ltx` then names the storage: it is the scope of the cells' Web Locks, so two stores of one
name never write a cell at once. The free-space check before a compaction only knows OPFS: on a
FilesApi over a port it is skipped, and `serveLtxStore` and module FilesApis take their own
`room`. The FilesApi must answer a ranged `read` with exactly the bytes asked, `stats` with the
size, take a streamed `write`, and `move` a file (atomically where it can: on S3 or a KV store a
move is a copy and a delete). The RPC client never runs in the shard worker, which blocks on the
shared buffer and could not receive answers; it runs in the store worker. The VFS numbers its
requests and the store tags each answer with its request's number, so the late answer to a
request the VFS gave up on (its 30 s wait, a slow remote FilesApi) is not read as the next
one's. All three ways are tested
in Chromium (`e2e-browser/ltx-files.spec.ts`) and, with the shared buffer awaited instead of
blocked on, in Node (`test/p39-files-rpc.test.ts`, `test/p40-ltx-store-files.test.ts`).

#### A project at the origin's root: `root`

An app that builds absolute paths (EmDash's admin calls `/_emdash/…`) cannot live under
`<basePath><name>/`. `installProjectRouter(self, { basePath, root: { name, passthrough, hostPage } })`
gives it the whole origin. Every same-origin request outside `basePath` and the `passthrough`
prefixes (the host page's own files) goes to project `name` with its URL unchanged, including
navigations. A navigation that finds no tab running the project's shards is sent to `hostPage` with
`?next=<the URL it asked for>`, since nothing else of the origin could start them.
[examples/emdash](../../../examples/emdash) is served this way, from static files: see the
[live demo](https://cellb-emdash.httpeers.net).

### A sharded origin: `CellRouter` in the ServiceWorker

```
tab ── navigator.locks.request("cellb:shard:i") ──► holds shard i ──► spawns shard worker i
                                                                        (pool cellb-shard-i)
ServiceWorker: CellRouter
  ingress(req)   ─► any live shard's Worker fetch (control headers stripped)
  internal(req)  ─► the shard of the target cell: shardOf(id, N)
  WebSockets     ─► control port per shard, socket ports handed to the page
```

- Each shard is one Web Lock, one OPFS pool and one Dedicated Worker. A second tab queues on the
  locks, is served by the first tab's workers, and takes the shards over when that tab closes.
- `createShardWorker` runs in each shard worker. Its own cells stay local, and calls to other
  cells go upstream to the router. When the ServiceWorker restarts, it asks the pages to re-attach their links; the first
  request after a restart costs about one round trip to a page.
- In the demo, each shard worker also holds an owner lock (`cellb:owner:<shard>:<uuid>`), and the
  router requests it through its `watchOwner` option. The browser grants it the moment the worker
  or its tab dies, so the router fails the shard's in-flight requests within tens of milliseconds.
  A MessagePort reports nothing when its far side dies, so without this lock requests would hang.
- WebSockets have a heartbeat for the same reason. The client pings every 10 s by default and
  closes with `1006` after two periods without a pong. The server end closes after three periods
  without a ping.

The repository wires this topology in its sharded demo (`e2e-browser/pages/sharded`: the page, the
ServiceWorker and the shard worker). The package provides `CellRouter`, `createShardWorker`, `serviceWorkerConnector` and
`createWebSocketClass`.

## A fleet bucket on S3

With `bucket`, a browser node keeps its cells in the same bucket as celld nodes, in celld's layout,
so cells move between this browser, other browsers and celld
([Ownership & durability](ownership-and-durability.md)). A browser node:

- writes a node record that celld reads, marked as pressured, with placement weight 0 and an
  unroutable address. celld never pushes cells to it, and while the browser node is alive celld
  refuses requests for the cells it owns instead of taking them over;
- owns the cells requested through it, logs their commits as LTX (changed pages from the SQLite
  WASM page hook), publishes their alarms in the wake index, and keeps R2 objects at
  `r2/<bucket>/<key>`;
- stops acknowledging writes when its node lease could have lapsed (a frozen tab), and releases its
  cells when the runtime closes.

The page signs each S3 request with SigV4 itself. There are two ways to let it reach the bucket.

### Directly, with CORS on the bucket

The bucket must accept the page's origin. The rules below list the headers the S3 store sends and
reads. Conditional writes are used for ownership, and user metadata holds R2's `celld-r2` record:

```json
[
  {
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": [
      "authorization", "content-type", "x-amz-date", "x-amz-content-sha256",
      "x-amz-meta-*", "if-match", "if-none-match",
      "cache-control", "content-disposition", "content-encoding", "content-language"
    ],
    "ExposeHeaders": ["etag", "last-modified", "x-amz-meta-celld-r2", "content-type",
      "cache-control", "content-disposition", "content-encoding", "content-language"],
    "MaxAgeSeconds": 3600
  }
]
```

AWS: `aws s3api put-bucket-cors --bucket cells --cors-configuration '{"CORSRules": [...]}'`.
RustFS and MinIO accept the same rules through their S3 API.

```ts
bucket: { s3: { endpoint: "https://s3.eu-west-1.amazonaws.com", bucket: "cells", prefix: "prod",
  region: "eu-west-1", accessKeyId, secretAccessKey }, node: "browser-<id>" }
```

`prefix` is the PREFIX in celld's `s3://BUCKET/PREFIX`. Credentials in a page are visible to its
user, so give the page a key limited to the bucket and prefix.

### Through a same-origin proxy

No CORS is needed. The page sends to its own origin (`/s3/...`), and the proxy forwards the
requests to S3 unchanged. SigV4 covers the host and path, so the page signs **as the real
endpoint**:

```ts
bucket: { s3: { endpoint: `${location.origin}/s3`, signAs: "https://s3.eu-west-1.amazonaws.com",
  bucket: "cells", prefix: "prod", accessKeyId, secretAccessKey }, node: "browser-<id>" }
```

The proxy must keep the path after `/s3`, set `Host` to the real endpoint, and pass the body and the
`authorization`, `x-amz-*` and `if-*` headers through. With Vite, as in the demo pages' config:

```ts
server: { proxy: { "/s3": { target: "https://s3.eu-west-1.amazonaws.com", changeOrigin: true,
  rewrite: (p) => p.replace(/^\/s3/, "") } } }
```

nginx:

```nginx
location /s3/ {
  proxy_pass https://s3.eu-west-1.amazonaws.com/;
  proxy_set_header Host s3.eu-west-1.amazonaws.com;
  proxy_request_buffering off;
}
```

### In this origin's OPFS

`bucket: { opfs: "<dir>", node }` keeps a fleet bucket in OPFS. This gives persistence and
hand-over between tabs or workers without a server, but its conditional writes are atomic only
within one writer.

## What breaks

- **`NoModificationAllowedError` when a worker opens SQLite.** Another worker holds the same pool
  name. Give each worker its own `pool`, or let only the shard-lock holder open a shard's pool.
- **`SAH pool is full` when many cells start at once.** A burst of new databases or journals
  outran the pool's growth. `browserProjectRuntime` starts the pool with 64 files, and
  `sahpoolOpener` on its own with 16. With `sahpoolOpener`, pass a larger `initialCapacity` for workloads that open many cells together.
- **`AsyncLocalStorage.getStore()` returns another cell's store, or `undefined` after an
  `await`**, in a browser. The code's `await` was not lowered. Either the bundle was not made by
  `bundleWorkerForBrowser` with nodejs_compat, or a site for a nodejs_compat project was made by
  `createProjectSite` without `nodeCompat`. Code in an async generator, or (on a site) in an async
  method that uses `super`, sees no store after its `await`s.
- **Every S3 request fails with a CORS error** in the console, or `PUT` succeeds but ownership never
  works. The bucket lacks a CORS rule, or does not expose `etag`, which conditional writes need.
- **`SignatureDoesNotMatch` through a proxy.** `signAs` is missing or differs from the host the proxy
  sends to, or the proxy rewrote the path.
- **`storage quota exceeded writing …/ltx/…`** with `bucket: { ltx }`. The origin's storage is
  full. The commit fails and nothing is left half-written; if the transaction had written, the
  Durable Object resets, as on workerd. Past the quota, Chromium's `SyncAccessHandle.write()`
  does not throw. It returns an error code as an unsigned count (4294967288), and the store
  checks for that. In a Playwright context `navigator.storage.estimate()` overstates the room.
- **`ltx: cell … is open in another tab or worker (waited 20 s)`.** Another store holds the cell's
  Web Lock. Either another tab runs the same shard over the same directory, or a closed page's
  store worker has not ended. Requests to that cell fail until it is released.
- **`ltx: short read of …`** in the console. A file changed under a cell's view of it, because a
  compaction swapped it. The store reopens the cell and reads again. If it keeps happening,
  something else is writing to the directory.
- **Two tabs on one OPFS bucket corrupt each other's cells.** Conditions are checked first and
  written afterwards, so with two writers both can win. Use one tab or worker at a time, or S3.
- **A WebSocket closes with `1006` although nobody closed it.** The heartbeat found the far end
  gone, which takes 20–40 s with the default 10 s period. The tab or worker at the other end was
  closed, frozen or killed. On a page's main thread, background throttling can delay pings; pass worker-timers as the
  client's `timers`.
- **Cookies through `installProjectRouter` are readable by the page and all have `Path=/`.** A
  browser drops `Cookie` from every `Request` and `Set-Cookie` from every `Response` it builds,
  and a ServiceWorker's responses set no cookies. So Worker code's `Request` and `Response` keep
  both headers in a standalone `Headers`. The router sends the page's cookies to the shard as
  `x-cellb-cookie`. The Worker's `Set-Cookie` values come back as `x-cellb-set-cookie`, and the
  router stores them with the Cookie Store API (`src/project/browser-cookies.ts`). Cookies written
  by script cannot be `HttpOnly`. Chromium also lets a ServiceWorker read cookies only for its
  default URL, so every cookie is stored with `Path=/`. A `Response` built outside Worker code (`fetch()`'s, or
  the platform's) still drops `Set-Cookie`.
- **A `Request` arrives without `Upgrade` or `Sec-WebSocket-Protocol`.** Browsers drop forbidden
  headers from every `new Request()`. CellB carries them as own properties and `x-cellb-*` headers,
  and the `Request` global of Worker code carries them into its copies (`new Request(req)`, which
  partyserver makes). A copy made with the host's own `Request`, from code outside the Worker
  bundle, loses them.
- **The first request after the ServiceWorker was stopped is slower**, by tens of milliseconds,
  because the ServiceWorker first asks a page to re-attach the shard links. If no page is open, it fails.
- **A browser fleet node owns cells but celld cannot reach them.** This is by design. celld
  refuses those requests while the browser node lives, and takes the cells over once its node
  lease lapses.

## Firefox and WebKit

The suite is written against Chromium. `pnpm e2e:firefox` runs it in Firefox (Playwright's own
build, installed with `npx playwright install firefox`), where it passes. It skips what Chromium
skips (the `knownGap` scenarios) and the two specs described below.

Firefox 157 runs module ServiceWorkers, module Dedicated Workers, OPFS synchronous access handles
(sahpool) and Web Locks. What differs:

- **A forwarded request body arrives as the text `[object ReadableStream]`.** Firefox has no
  `Request.body` and does not take a `ReadableStream` as a request body; it stores the stream's
  string form instead. `createCellRuntime` gives Firefox a `request.body`, a stream read from
  `arrayBuffer()` on its first read, so the whole body is in memory first. Worker code that reads
  it works (specs: `celld-projects` and `site-projects` `kv` and `r2`, `miniflare`). Code that
  passes it on, as in `new Request(url, { body: request.body })`, sends that text. Pass
  `await request.arrayBuffer()` or the request itself instead. The getter sits on a prototype
  below `Request.prototype` rather than on it, because `@statewalker/webrun-http-streams` checks
  whether `Request.prototype` owns `body` to decide whether it may build requests with stream
  bodies, and that check must keep returning false. Where CellB rebuilds a request itself (a
  scheme restored on a node's link, a URL given back on an isolate's port), it reads the whole
  body there (spec: `peer-routing`).
- **Storage errors use V8's wording.** When `storage.put` gets a value that structured clone
  refuses, it throws CellB's own `TypeError` with the message from CellB's V8 serializer
  (`() => 1 could not be cloned.`) instead of SpiderMonkey's (`Function object could not be
  cloned.`). The error then reads as it does on workerd and celld (spec: `storage-details`).
- **Under Playwright's Firefox, a navigation the ServiceWorker lets through to the network leaves
  the page uncontrolled** (`navigator.serviceWorker.controller === null`, after a reload or in a
  new tab). Its requests then reach the dev server instead of the router, and fail with
  `JSON.parse: unexpected character`. Playwright's Firefox takes back every request the
  ServiceWorker does not answer. A ServiceWorker with no fetch handler, or one that answers the
  navigation, keeps control (`e2e-browser/probes/sw-minimal.probe.spec.ts`), so the sharded demo's
  ServiceWorker answers navigations with `fetch(request)`. We have not checked whether Firefox
  outside Playwright behaves the same way.
- The two `sharded` specs that stop the ServiceWorker use the Chrome DevTools Protocol and are
  skipped outside Chromium.

WebKit is not run, and is not a target for now. `pnpm e2e:webkit` is wired up, but Playwright's
WebKit build needs the system library `libavif16` (`libavif.so.16`). Without it, the browser fails
to launch with `Host system is missing dependencies to run browsers`.
