# Running cells in a browser

A browser has no server process, no `node:sqlite` and no way for a ServiceWorker to accept a
WebSocket. cellb still runs a project's Workers and Durable Objects there: SQLite WASM on OPFS in a
Dedicated Worker, requests through a ServiceWorker, WebSockets over MessagePorts. This page covers
the four ways to wire it, the S3 setup for a fleet bucket, what fails, and what differs in Firefox
and WebKit.

## What a browser forces

- **Synchronous SQLite needs a Dedicated Worker.** OPFS synchronous access handles exist only there.
  `sahpoolOpener` (the opfs-sahpool VFS) needs no COOP/COEP headers, so any static host works.
- **An opfs-sahpool pool is exclusive.** A second worker opening the same pool name fails with
  `NoModificationAllowedError`. Storage is therefore partitioned: one pool per worker.
- **An opfs-sahpool pool has a fixed number of files until it grows**, and growing is asynchronous
  while opening a database is not. `sahpoolOpener` gives the runtime `room(cellKey)`: a cell's first
  event waits for room (about three files per cell: the database and its journal), and the pool
  grows in the background whenever less than half of it is free.
- **One worker is one thread.** Its cells interleave; their SQLite I/O runs on that thread. For
  parallel work, spread the project over several workers (next section).
- **Journals stay in the pool.** `sahpoolOpener` opens databases with `journal_mode=PERSIST`: the
  rollback journal keeps its pool slot between commits instead of being created and deleted on each
  one. The database file is the same as with the default `DELETE` (only WAL marks it).
- **`AsyncLocalStorage` needs help.** Browsers have no async context yet: for a nodejs_compat
  project, `browserProjectRuntime` makes promise and timer continuations carry their stores, and
  the code's `await` is lowered so that it goes through them: by `bundleWorkerForBrowser` in a
  bundle, by `createProjectSite` in a site's modules ([gaps.md](gaps.md)). A browser with TC39
  AsyncContext needs neither: `node:async_hooks` then runs on it, and a site lowers nothing.
- **A ServiceWorker cannot spawn workers** and is stopped when idle, dropping every port it held.
  It can route requests, hold Web Locks and pass MessagePorts, so it routes and a page owns the
  workers.
- **A ServiceWorker cannot intercept WebSockets.** Pages and objects get a WebSocket class whose
  frames travel over MessagePorts ([ADR 0006](adr/0006-websockets-over-messageports.md)).
- **Without an open page nothing runs.** No page means no Dedicated Worker and no SQLite. Cells that
  must stay reachable live on a fleet bucket that server nodes share.

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
  `"path"` too). A Flue app built for Cloudflare runs this way (examples/flue); or
- `{ site }` — the base URL of an in-browser HTTP server made by `createProjectSite` and hosted by
  `@statewalker/webrun-site-host`, which compiles the project's sources on request
  (`@statewalker/webrun-modules`). Loaded Workers' code is uploaded to it and imported from URLs.
  The project's `cloudflare:workers` has its own `env` and `exports` (Workers loaded into its
  realm get empty ones; in isolates, their own), and `cloudflare:email` loads. With `nodeCompat`
  the site lowers `await` in the modules it serves, so `AsyncLocalStorage` answers as in a bundle;
  the site's `nodeCompat` must match the project's flag (see below).

A loaded Worker's `cloudflare:workers` has its own `env` and `exports` (its `WorkerCode.env`, and
stubs of its own entrypoints), except on a site without `isolateScript`.
With `isolateScript`, each loaded Worker runs in its own Dedicated Worker; without it, it runs in
this worker's realm. The package ships that worker as `@statewalker/cellb/isolate-worker`; with
Vite, `import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url"` and pass
`isolateScript: new URL(isolateWorker, import.meta.url)`.

The host app (`e2e-browser/pages/host`; `pnpm browser:dev`, then `/host/`) is this topology: pick a
project folder, a node name and a bucket, and the project is served at its own URL.

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
it; a Durable Object call from any worker runs in the owner's worker, so cells run in parallel
threads. Any worker takes ingress (the Worker's `fetch`), and `fetch` spreads requests over them.
The worker script is one line:

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveProjectShard } from "@statewalker/cellb/browser";
serveProjectShard({ sqlite3: () => sqlite3InitModule({ print() {}, printErr() {} }) });
```

- Placement is fixed by the cell id: a few dozen cells spread unevenly (hashing), and nothing
  rebalances them.
- The workers belong to the page: closing it stops them. To share them between tabs, use the
  next topology.
- `browserProjectRuntime({ route })` is the building block: any placement that maps a cell to the
  worker hosting it works the same way.

### A project shared by the tabs: `joinProjectShards` and `installProjectRouter`

```
ServiceWorker: installProjectRouter(self, { basePath: "/app/" })
  /app/<name>/…  ─► the project's CellRouter ─► the live shard with the fewest requests in flight
  shard → shard  ─► the shard the sender named (x-cellb-shard)

every tab: joinProjectShards({ name, shards: 4, spawn, config, code, serviceWorker })
  presence lock  cellb:<name>:tab:<joined-at>-<uuid>
  shard i        → tab (i mod n) of the n tabs present, oldest first; one Web Lock per shard
  shard worker:  serveProjectShard({ sqlite3 }) — pool <name>-shard-i, linked to the router
```

Every tab of the origin sends requests to `<basePath><name>/…`; the ServiceWorker passes them,
with their URL unchanged (as a Worker on a Cloudflare route sees them; `stripBase: true` gives
the Worker `/…` instead), to a shard worker, wherever it runs. The tabs split the shards evenly:
each computes the same owners from the tabs present and takes its own, so a project of 4 shards
runs 4 / 0 in one tab, 2 / 2 in two, 2 / 1 / 1 in three — more tabs, more processes, more cores.

- **A tab joins or leaves (`close()`):** the shards whose owner changes are handed over. The router
  stops sending the shard new requests (they wait for the next owner), lets the ones in flight
  finish for up to `drainMs` (5 s), then the old worker closes its runtime and gives up its OPFS
  pool, and the next owner opens the same pool: the cells move with the shard. A long-poll or
  SSE stream still open keeps the drain waiting until `drainMs`. Before it closes, the old worker
  closes its sockets with `1001` (going away), so their clients reconnect to the next owner at
  once instead of noticing through the heartbeat.
- **Pages open sockets** with `createWebSocketClass(serviceWorkerConnector(serviceWorker))`: the
  ServiceWorker routes the upgrade to a shard worker and hands the page the socket's port, so the
  socket then runs page ↔ shard worker, without the ServiceWorker (it survives a restart of it).
- **A tab closes or crashes:** it runs no code. Its locks are released, the router sees each shard
  worker's own lock go and fails the requests in flight there (`ShardOwnerLostError`), and the
  other tabs take the shards over within `checkMs` (1 s).
- **The ServiceWorker restarts:** it asks the tabs for their shards' links again. The browser stops
  an idle ServiceWorker, and its ports die without telling anyone. A request to it starts it
  again, but a call that begins in a shard (an alarm, a timer, a WebSocket message) to an object
  in another shard does not. So the router holds a Web Lock (`cellb:router:<uuid>`) while it
  lives, and each shard watches it. When the lock is released, the shard drops its links, and its
  next call into another shard waits: the shard asks its tab to post a message to the
  ServiceWorker, which starts it again, and that call goes through once the links are back. A call
  already in flight when the ServiceWorker stopped has lost its answer: it fails ("The router was
  lost while this call was in flight"), and may or may not have been applied. To make that rare,
  a shard with calls into other shards in flight keeps the ServiceWorker up: every 20 s its tab
  posts a message to it, since those calls travel over MessagePorts and are no events to it
  (Chromium stops a ServiceWorker after about 30 s without events). The ServiceWorker can still
  stop (an update, a crash, memory pressure), so the failure stays.
- **Tests of the idle timeout need a Chromium without Playwright's DevTools sessions:** Playwright
  attaches one to every ServiceWorker, which keeps it running. `e2e-browser/raw-chromium.ts` drives
  a separate Chromium over CDP, attached to its pages only.
- Placement inside the project is still by cell id (`shardOf`): a few dozen cells spread unevenly.
- With `bucket`, each shard is a fleet node (`<node>-s<i>`); use S3, as an OPFS bucket has one
  writer at a time.

### A sharded origin: `CellRouter` in the ServiceWorker

```
tab ── navigator.locks.request("cellb:shard:i") ──► holds shard i ──► spawns shard worker i
                                                                        (pool cellb-shard-i)
ServiceWorker: CellRouter
  ingress(req)   ─► any live shard's Worker fetch (control headers stripped)
  internal(req)  ─► the shard of the target cell: shardOf(id, N)
  WebSockets     ─► control port per shard, socket ports handed to the page
```

- Each shard is one Web Lock, one OPFS pool and one Dedicated Worker
  ([ADR 0005](adr/0005-fixed-shards-in-the-browser.md)). A second tab queues on the locks, is served
  by the first tab's workers, and takes the shards over when that tab closes.
- `createShardWorker` runs in each shard worker: its own cells stay local, others go upstream to the
  router. When the ServiceWorker restarts, it asks the pages to re-attach their links; the first
  request after a restart costs about one round trip to a page.
- Each shard worker also holds an owner lock (`cellb:owner:<shard>:<uuid>`). The router requests it
  (`watchOwner`); the browser grants it the moment the worker or its tab dies, so the router fails
  the shard's in-flight requests within tens of milliseconds. A MessagePort reports nothing when its
  far side dies, so without this, requests would hang.
- WebSocket sockets have a heartbeat for the same reason: the client pings every 10 s by default
  and closes `1006` after two missed pongs; the server end closes after three missed pings.

The repository wires this topology in its sharded demo (the page, the ServiceWorker and the shard
worker); the package provides `CellRouter`, `createShardWorker`, `serviceWorkerConnector` and
`createWebSocketClass`.

## A fleet bucket on S3

With `bucket`, a browser node keeps its cells in the same bucket as celld nodes, in celld's layout,
so cells move between this browser, other browsers and celld
([ownership-and-durability.md](ownership-and-durability.md)). A browser node:

- writes a node record celld reads: pressured, placement weight 0, and an unroutable address, so
  celld never pushes cells to it and refuses, rather than takes over, requests for cells it owns
  while it is alive;
- owns the cells requested through it, logs their commits as LTX (changed pages from the SQLite
  WASM page hook), publishes their alarms in the wake index, and keeps R2 objects at
  `r2/<bucket>/<key>`;
- stops acknowledging writes when its node lease could have lapsed (a frozen tab), and releases its
  cells when the runtime closes.

The page signs each S3 request with SigV4 itself. There are two ways to let it reach the bucket.

### Directly, with CORS on the bucket

The bucket must accept the page's origin. The headers are those the S3 store sends and reads
(conditional writes for ownership, user metadata for R2's `celld-r2` record):

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

`prefix` is celld's `s3://BUCKET/PREFIX`. Credentials in a page are visible to its user: give the
page a key limited to the bucket and prefix.

### Through a same-origin proxy

No CORS is needed: the page sends to its own origin (`/s3/...`), and the proxy forwards to S3
unchanged. SigV4 covers the host and path, so the page signs **as the real endpoint**:

```ts
bucket: { s3: { endpoint: `${location.origin}/s3`, signAs: "https://s3.eu-west-1.amazonaws.com",
  bucket: "cells", prefix: "prod", accessKeyId, secretAccessKey }, node: "browser-<id>" }
```

The proxy must keep the path after `/s3`, set `Host` to the real endpoint, and pass the body and the
`authorization`, `x-amz-*` and `if-*` headers through. Vite (as in the demo pages' config):

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

`bucket: { opfs: "<dir>", node }` keeps a fleet bucket in OPFS: persistence and hand-over between
tabs or workers with no server. Its conditional writes are atomic only within one writer.

## What breaks

- **`NoModificationAllowedError` when a worker opens SQLite.** Another worker holds the same pool
  name. Give each worker its own `pool`, or let only the shard-lock holder open a shard's pool.
- **`SAH pool is full` when many cells start at once.** A burst of new databases or journals
  outran the pool's growth (`browserProjectRuntime` starts with 64 files). With `sahpoolOpener`,
  pass a larger `initialCapacity` for workloads that open many cells together.
- **`AsyncLocalStorage.getStore()` returns another cell's store, or `undefined` after an
  `await`**, in a browser. The code's `await` was not lowered: a bundle of your own, not made by
  `bundleWorkerForBrowser` with nodejs_compat, or a site made by `createProjectSite` without
  `nodeCompat` for a nodejs_compat project. Code in an async generator, or (on a site) in an async
  method that uses `super`, sees no store after its `await`s.
- **Every S3 request fails with a CORS error** in the console, or `PUT` succeeds but ownership never
  works. The bucket lacks a CORS rule, or does not expose `etag`: conditional writes need it.
- **`SignatureDoesNotMatch` through a proxy.** `signAs` is missing or differs from the host the proxy
  sends to, or the proxy rewrote the path.
- **Two tabs on one OPFS bucket corrupt each other's cells.** Conditions are checked and then
  written; with two writers both can win. Use one tab or worker at a time, or S3.
- **A WebSocket closes with `1006` although nobody closed it.** The heartbeat found the far end gone
  (20–40 s with the default 10 s period): the tab or worker at the other end was closed, frozen or
  killed. On a page's main thread, background throttling can delay pings; pass worker-timers as the
  client's `timers`.
- **`Set-Cookie` is missing from responses in the browser.** A `Response` built in a browser drops
  it, and a ServiceWorker cannot hand one to a page. Node keeps it.
- **A `Request` arrives without `Upgrade` or `Sec-WebSocket-Protocol`.** Browsers drop forbidden
  headers from every `new Request()`. cellb carries them as own properties and `x-cellb-*` headers,
  and the `Request` global of Worker code carries them into its copies (`new Request(req)`, as
  partyserver makes); a copy made with the host's own `Request` (code outside the Worker bundle)
  loses them.
- **The first request after the ServiceWorker was stopped is slower** (tens of milliseconds): the
  ServiceWorker asks a page to re-attach the shard links first. If no page is open, it fails.
- **A browser fleet node owns cells but celld cannot reach them.** By design: celld refuses those
  requests while the browser node lives, and takes the cells after its node lease lapses.

## Firefox and WebKit

The suite is written against Chromium; `pnpm e2e:firefox` (Playwright's own build:
`npx playwright install firefox`) runs it in Firefox, where it passes. It skips what Chromium skips
(the `knownGap` scenarios) and the two specs below.

Firefox 157 runs module ServiceWorkers, module Dedicated Workers, OPFS synchronous access handles
(sahpool) and Web Locks. What differs:

- **A forwarded request body arrives as the text `[object ReadableStream]`.** Firefox has no
  `Request.body` and does not take a `ReadableStream` as a request body; it stores the stream's
  string form. `createCellRuntime` gives Firefox a `request.body` (a stream read from
  `arrayBuffer()` on its first read, so the whole body is in memory first), and Worker code that
  reads it works (specs: `celld-projects` and `site-projects` `kv` and `r2`, `miniflare`). Code
  that passes it on, `new Request(url, { body: request.body })`, sends that text: pass
  `await request.arrayBuffer()`, or the request itself. The getter sits on a prototype below
  `Request.prototype`, not on it: `@statewalker/webrun-http-streams` asks whether
  `Request.prototype` owns `body` to decide whether it may build requests with stream bodies, and
  must keep hearing no. Where cellb rebuilds a request itself (a scheme restored on a node's link, a
  URL given back on an isolate's port) it reads the body whole there (spec: `peer-routing`).
- **Storage refusals are worded as V8 words them.** `storage.put` of a value structured clone
  refuses throws cellb's own `TypeError`, with the message of cellb's V8 serializer
  (`() => 1 could not be cloned.`), not SpiderMonkey's (`Function object could not be cloned.`), so
  it reads as on workerd and celld (spec: `storage-details`).
- **Under Playwright's Firefox, a navigation the ServiceWorker lets through to the network leaves
  the page uncontrolled** (`navigator.serviceWorker.controller === null`, after a reload or in a
  new tab), so its requests reach the dev server, not the router (`JSON.parse: unexpected
  character`). Playwright's Firefox takes back every request the ServiceWorker does not answer.
  A ServiceWorker with no fetch handler, or one that answers the navigation, keeps control
  (`e2e-browser/probes/sw-minimal.probe.spec.ts`), so the sharded demo's ServiceWorker answers
  navigations with `fetch(request)`. Whether Firefox outside Playwright does the same is not
  checked.
- The two `sharded` specs that stop the ServiceWorker use the Chrome DevTools Protocol and are
  skipped outside Chromium.

WebKit is not run, and is not a target for now. `pnpm e2e:webkit` is wired, but Playwright's WebKit
build needs the system `libavif16` (`libavif.so.16`), and fails to launch with `Host system is
missing dependencies to run browsers` without it.
