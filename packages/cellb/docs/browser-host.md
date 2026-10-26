# Running cells in a browser

A browser has no server process, no `node:sqlite` and no way for a ServiceWorker to accept a
WebSocket. cellb still runs a project's Workers and Durable Objects there: SQLite WASM on OPFS in a
Dedicated Worker, requests through a ServiceWorker, WebSockets over MessagePorts. This page covers
the two ways to wire it, the S3 setup for a fleet bucket, and what fails.

## What a browser forces

- **Synchronous SQLite needs a Dedicated Worker.** OPFS synchronous access handles exist only there.
  `sahpoolOpener` (the opfs-sahpool VFS) needs no COOP/COEP headers, so any static host works.
- **An opfs-sahpool pool is exclusive.** A second worker opening the same pool name fails with
  `NoModificationAllowedError`. Storage is therefore partitioned: one pool per worker.
- **A ServiceWorker cannot spawn workers** and is stopped when idle, dropping every port it held.
  It can route requests, hold Web Locks and pass MessagePorts, so it routes and a page owns the
  workers.
- **A ServiceWorker cannot intercept WebSockets.** Pages and objects get a WebSocket class whose
  frames travel over MessagePorts ([ADR 0006](adr/0006-websockets-over-messageports.md)).
- **Without an open page nothing runs.** No page means no Dedicated Worker and no SQLite. Cells that
  must stay reachable live on a fleet bucket that server nodes share.

## Two topologies

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

`browserProjectRuntime` installs the Workers globals (`Response` that accepts status 101,
`WebSocketPair`, `caches`, `HTMLRewriter`, and `Buffer`/`process` for `nodejs_compat`), imports the
code and builds the runtime from the wrangler configuration. The code is either:

- `{ bundle }` — one ES module built for browsers, whose `cloudflare:workers` import and Workers
  globals read what the runtime installs; or
- `{ site }` — the base URL of an in-browser HTTP server made by `createProjectSite` and hosted by
  `@statewalker/webrun-site-host`, which compiles the project's sources on request
  (`@statewalker/webrun-modules`). Loaded Workers' code is uploaded to it and imported from URLs.

With `isolateScript`, each loaded Worker runs in its own Dedicated Worker; without it, it runs in
this worker's realm. The package ships that worker as `@statewalker/cellb/isolate-worker`; with
Vite, `import isolateWorker from "@statewalker/cellb/isolate-worker?worker&url"` and pass
`isolateScript: new URL(isolateWorker, import.meta.url)`.

The host app (`e2e-browser/pages/host`; `pnpm browser:dev`, then `/host/`) is this topology: pick a
project folder, a node name and a bucket, and the project is served at its own URL.

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
- `createShardHost` runs in each shard worker: its own cells stay local, others go upstream to the
  router. When the ServiceWorker restarts, it asks the pages to re-attach their links; the first
  request after a restart costs about one round trip to a page.
- Each shard worker also holds an owner lock (`cellb:owner:<shard>:<uuid>`). The router requests it
  (`watchOwner`); the browser grants it the moment the worker or its tab dies, so the router fails
  the shard's in-flight requests within tens of milliseconds. A MessagePort reports nothing when its
  far side dies, so without this, requests would hang.
- WebSocket sockets have a heartbeat for the same reason: the client pings every 10 s by default
  and closes `1006` after two missed pongs; the server end closes after three missed pings.

The repository wires this topology in its sharded demo (the page, the ServiceWorker and the shard
worker); the package provides `CellRouter`, `createShardHost`, `serviceWorkerConnector` and
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
  headers from every `new Request()`. cellb carries them as own properties and `x-cellb-*` headers;
  code that rebuilds requests outside cellb loses them.
- **The first request after the ServiceWorker was stopped is slower** (tens of milliseconds): the
  ServiceWorker asks a page to re-attach the shard links first. If no page is open, it fails.
- **A browser fleet node owns cells but celld cannot reach them.** By design: celld refuses those
  requests while the browser node lives, and takes the cells after its node lease lapses.
- **Isolated facets in a browser are not in the fleet bucket.** A Durable Object class of a loaded
  Worker keeps its database in the isolate's OPFS pool only; see [gaps.md](gaps.md).
