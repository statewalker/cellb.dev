# Missing Aspects in Detail: What Each Gap Needs and How to Prove It

_Working document — 28 September 2026_

Companion to document 07 (the short list). For each missing aspect: what Cloudflare/celld
does, what webrun-cells has, what it takes, and the test that would prove it. Decisions
taken today are marked **Decision**; three of them already have prototypes (docs 09–11).

## 1. Durability beyond the local store

- **CF/celld:** a commit is acknowledged when replicated (celld: SQLite pages shipped to S3).
- **Now:** the output gate waits on `CellDurability.committed()`, a no-op by default; OPFS
  and local files are the only copy.
- **Decision (user):** first step = a **backup callback** called periodically with a
  consistent image of each changed cell, e.g. saved to a webrun-files `FilesApi`;
  restore on open. Implemented (doc 10). RPO = interval.
- **Still needed:** changeset shipping (RPO ≈ 0) with the output gate waiting on it;
  epoch-fenced manifests (`FencedManifest` exists) so two owners cannot both write;
  rollback of the local DB when a durable commit fails; `navigator.storage.persist()`.
- **Proof:** kill the owner after N acknowledged writes; a new owner restoring from the
  store sees exactly the acknowledged writes.

## 2. Server-side ownership

- **CF:** one global owner per object id.
- **Now:** `SqliteFileLease`, `CasLease` + `FencedManifest`, exclusive SQLite files.
- **Decision (user):** apply **Miniflare 4's strategy** on the server: heartbeat files in a
  shared registry, the oldest live candidate owns. Implemented as `RegistryLease` (doc 09).
  Like Miniflare it has no fencing, so on one host it is paired with exclusive SQLite
  cell files; across hosts `CasLease` remains the safe option.

## 3. WebSockets

- **CF:** `new WebSocketPair()`, `server.accept()`, `new Response(null, { status: 101,
  webSocket })`, hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, tags,
  auto-response, attachments).
- **Browser constraint:** a ServiceWorker cannot intercept WebSocket connections, and
  the platform `Response` rejects status 101.
- **Decision (user):** client code keeps `new WebSocket(url)`; webrun-modules rewrites the
  free global through `~deps` to a **WebSocket-compatible class over MessagePorts**.
  Implemented for both sides (doc 11), without hibernation.
- **Still needed:** port routing page → ServiceWorker → owning page → shard worker (design
  in doc 11), hibernation API, backpressure (`bufferedAmount` is always 0).

## 4. Alarms

- **CF:** one alarm per object, `alarm()` handler, at-least-once, retries with backoff.
- **Needed:** alarm time in `_cf_METADATA`, scheduler in the shard worker driven by an
  injectable `Clock` (exists), catch-up of overdue alarms when a shard is opened (tabs
  freeze or close), retry policy, `deleteAll` clears the alarm.
- **Proof:** fake-clock tests; e2e: set alarm, close all tabs, reopen after the due time →
  fires once.

## 5. RPC richness

- **Needed:** stubs and functions as arguments/results (reference passing over ports),
  `RpcTarget`, promise pipelining, `using` disposal, `ReadableStream` arguments; a value
  codec at least as rich as structured clone (webrun-msgpack or real `postMessage`).

## 6. Worker Loader, facets, isolation

- **Needed:** `LOADER.get(hash, factory)` building code with webrun-modules; `ctx.facets`;
  one worker per namespace or per tenant; untrusted code in an opaque-origin iframe whose
  storage stays in the trusted shard worker (SQL over ports — sync SQL across realms is
  the hard part: `Atomics.wait` needs cross-origin isolation).

## 7. Smaller API gaps

`ctx.exports`, `ctx.props`, `ctx.abort()`; `scheduled`/`queue` handlers; KV/R2/D1 and
service bindings (webrun-files and statewalker-db are natural backends); point-in-time
recovery (keep N backups as bookmarks — doc 10 makes this cheap); storage limits;
streaming cursors; exact `rowsRead`.

## 8. Runtime behaviour

Input gate for non-storage I/O (AsyncContext); idle eviction/hibernation; memory limits;
shard rebalancing (fixed N today); ServiceWorker keep-alive (unvalidated).

## 9. Verification

Conformance suite against `celld dev` (P09); Firefox and WebKit; a real S3/R2 bucket for
`CasLease` and for the FilesApi backup (webrun-files-s3).

## 10. Open threads

- Which RPO is acceptable before changesets are needed?
- Hibernation semantics in a browser shard: can sockets survive a shard worker restart?
- Are alarms needed while no tab is open (server peer) or only on reopen?
