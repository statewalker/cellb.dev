# What Is Missing to Implement Durable Objects in the Browser

_Working document — 28 September 2026_

## 1. What already works

A Worker module and its Durable Object classes, unmodified, run in Chromium: requests
through a ServiceWorker, objects in shard workers with SQLite on OPFS, synchronous SQL,
KV, implicit transactions, input/output gates, JS RPC and `fetch` on stubs, streaming
responses, cross-shard calls, single ownership across tabs (Web Locks), takeover on tab
close, fast failure on dead owners. The same core runs on Node with file leases or S3-style
CAS leases.

## 2. Missing Durable Object API

| Area | Missing | Browser-specific difficulty |
|---|---|---|
| Alarms | `setAlarm/getAlarm/deleteAlarm`, `alarm()` handler, retries with backoff, catch-up after downtime | fire only while some tab owns the shard; frozen/closed tabs → catch-up on reopen |
| WebSockets | `acceptWebSocket`, hibernation handlers, `getWebSockets`, tags, auto-response, attachments | **a ServiceWorker cannot intercept WebSocket connections**: needs a client-side WebSocket shim over ports/webrun-streams |
| RPC | stubs/functions/`RpcTarget` as arguments, promise pipelining, `using` disposal, streams as args | only tagged-JSON types cross today |
| Context | `ctx.facets`, `ctx.exports`, `ctx.props`, `ctx.abort()` | — |
| Storage | point-in-time recovery bookmarks, key/value size limits, exact `rowsRead`, streaming cursors, `deleteAll` resetting alarms | — |
| Namespaces | `locationHint`, `jurisdiction` (ignored) | meaningless locally |
| Worker features | Worker Loader (`LOADER.get`), `cloudflare:workers` import mapping, other handlers (`scheduled`, `queue`), other bindings (KV, R2, D1, services) | code must be built in the browser (webrun-modules / webrun-transform) |

## 3. Missing runtime guarantees

- **Durability beyond the browser profile (P06).** OPFS is local and evictable; the
  output gate waits on a no-op. Needed: snapshots + changesets to a FilesApi (OPFS copy,
  S3, peer), epoch-fenced manifest, rollback to last durable state on failure,
  `navigator.storage.persist()` to reduce eviction.
- **Serving without an open tab.** Impossible in the browser; needs a server peer
  serving replicated shards under the same lease.
- **One ownership model across devices.** Web Locks only cover one browser profile; a
  shard shared with a server or another device needs the CAS lease + epochs everywhere.
- **Input gate for non-storage I/O** (`fetch`, timers) — needs AsyncContext or wrapping.
- **Isolation and limits.** All cells of a shard share one worker and realm; no memory
  limit per object; a CPU watchdog can only `terminate()` the whole shard; untrusted code
  needs a sandboxed iframe with an opaque origin (which then cannot reach the origin's
  OPFS) — to design in P08.
- **Lifecycle.** No idle eviction/hibernation, no memory pressure handling.
- **Sharding operations.** Fixed N, no rebalancing, hot shards are single-threaded.
- **SW restarts** cost one re-link round trip; keep-alive unvalidated.

## 4. Missing verification

- Conformance against real `celld dev` (P09) — the reference was never executed here.
- Firefox and Safari (module ServiceWorkers, OPFS sync handles, Web Locks behaviour).
- Real S3/R2 conditional writes.

## 5. Suggested order

1. **P06 durability/replication** — makes OPFS state recoverable and enables the server
   fallback; uses the existing epoch fencing.
2. **P07 alarms + WebSockets** — alarms with an injectable clock and catch-up; the WS shim
   is the biggest browser-specific item.
3. **P08 Worker Loader, facets, isolation** — webrun-modules builds, per-namespace workers,
   sandboxed iframes for untrusted code.
4. **P09 conformance** against node host, browser host and `celld dev`, plus Firefox/WebKit.
5. RPC richness and the smaller API gaps, driven by what the conformance suite shows.

## 6. Open threads

- Is a WebSocket shim acceptable to user code, or must `new WebSocket(url)` work unchanged
  (would require patching the global in pages)?
- Can untrusted DO code run in an opaque-origin iframe while its storage stays in the
  trusted origin's shard worker (storage via ports)?
- Server peer as the default owner and browsers as caches — or the reverse?
