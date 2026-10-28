# Compatibility with celld

celld (denoland/celld) runs Cloudflare Workers projects on a fleet of servers that share one bucket.
cellb answers the same requests the same way, and stores cells the same way, so one cell can be
served by celld, then by cellb in Node or a browser, then by celld again. This page lists what is
identical, how it is checked, and where the two still differ. The pinned celld version is 0.6.3.

## Features at a glance

| Feature | celld 0.6.3 | cellb, Node | cellb, browsers | How cellb is checked |
|---|---|---|---|---|
| Workers (stateless handlers) | supported | yes | yes | `hello`, `webapi`, `router`, `body` |
| Durable Objects / cells | supported | yes, same storage format | yes, same storage format | `counter`, `rpc`, `alarm`, workerd's tests; cells cross celld ↔ cellb |
| Durable Object facets | supported | yes | yes | `facets`, `facets-api` |
| KV | supported | yes (celld's code) | yes | `kv`, `kv-values` |
| Queues | supported | yes (celld's code) | yes | `queues`, `queues-api` |
| D1 | supported | yes (Miniflare's simulator) | yes | `d1`, D1 migrations |
| R2 | supported | yes, celld's bucket layout | yes | `r2`, `r2-api`, `r2-advanced` |
| Workflows | supported | yes (celld's engine) | yes | `workflow`, `workflow-api` |
| Cron triggers | supported | yes | yes | `cron` |
| Static assets | supported | yes (with Cloudflare's behaviour where celld has bugs) | yes | `static-assets`, `assets-api` |
| Dynamic Workers (Worker Loader) | supported | yes, a worker thread each | yes, a Dedicated Worker each | `dynamic-worker-tails`, the Worker Loader scenarios |
| WebSockets, hibernation | supported | yes | yes, over MessagePorts | `wsecho`, `wsclient`, `wd-websocket-*` (celld fails `wd-websocket-hibernation`, cellb passes it) |
| Vectorize-style search | example | yes | yes | `vectordb` |
| Workers AI (`ai` binding) | no binding (the `pi` example builds its own adapter) | yes, on an OpenAI-compatible endpoint the host names | yes | `p14-workers-ai`, Flue's `cloud` agent |
| Python Workers (Pyodide) | supported | no, out of scope ([gaps.md](gaps.md)) | no | not run |
| Containers | experimental (Docker or Podman) | no; reported in `unsupported` | no | not run |
| Agent frameworks: Flue, pi, opencode | examples (`pi`, `opencode` need the network) | yes, offline against a fake model | Flue | `examples/flue`, `examples/agents` |

## The same request gets the same answer

A project that runs on celld (`wrangler.jsonc` plus its `main`) loads unchanged with
`loadNodeProject` or `browserProjectRuntime`. The conformance corpus runs every project on both and
compares transcripts and user logs ([conformance.md](conformance.md)). Behaviours that only show in
those transcripts, and that cellb matches:

- An uncaught error answers `500`, `content-type: application/json`, body
  `Worker failed: rejected: <name>: <message>`. A handler returning something other than a
  `Response` is sent as its text with status 200.
- An inbound request has `request.cf` set to `{}`.
- A Durable Object `stub.fetch()` whose handler throws rejects with `rejected: <name>: <message>`; RPC
  errors keep their name, message and own properties such as `code`.
- SQL refusals use celld's authorizer wording (`not authorized`, `access to _cf_KV.scope is
  prohibited`); `sql.exec()` with several statements sums `rowsWritten`.
- D1 sessions return the bookmark `celld:primary`; ATTACH, TEMP objects and VACUUM are refused as by
  celld. There is no Durable Object bookmark API, as on celld.
- KV, Queues and R2 errors carry celld's messages and limits (`KV_ERROR: …`, `QUEUE_ERROR: …`,
  `R2 <op> (binding <NAME>): …`).
- Either end of a `WebSocketPair` may `send()` before `accept()` (celld queues the frame; workerd
  refuses).
- `WebSocketPair` ends start with `binaryType` `"blob"` when the project sets
  `websocket_standard_binary_type`, `"arraybuffer"` otherwise (loaded Workers always get the
  latter). `webSocketMessage()` of a hibernatable socket always receives an `ArrayBuffer`.

## The same cell is stored the same way

| Layer | celld | cellb |
|---|---|---|
| Object ids | namespace key `cells:v1:<len(script)>:<script>:<class>`; id = HMAC(SHA-256(key), name)[0..16] ‖ HMAC(key, first half)[0..16] | the same bytes ([ADR 0008](adr/0008-synchronous-idfromname.md)) |
| Fleet-wide namespaces | KV, D1 and Queues use keys that do not depend on the script | the same |
| Internal tables | `_cf_KV(scope, k, v)`, `_cf_ALARM`, `_cf_METADATA(scope, actor_name)`, `_cf_FACETS`, `_cf_WAKE` and their triggers | the same DDL, plus cellb's own `_cf_LOG` (the changeset log's sequence) |
| Stored values | V8 serialization, version 15 | a TypeScript V8 serializer, byte-identical to Node's on the tested corpus |
| Logs | LTX v3, legacy LZ4 frames, header flag `NO_CHECKSUM`, rolling checksums 0 | the same; the header of a re-encoded celld file is byte-identical |
| Generations | one per owner epoch, starting with a snapshot at TXID 1; restore reads the newest | the same |
| Facets | a database and LTX stream each, at `cells/<root>/facets/<SHA-256(name)[0..16] hex>/ltx/…`, the root's epoch | the same; rows are rescoped to the current run on open |
| Object names | `_cf_METADATA.actor_name` restored as `ctx.id.name` when woken by id | the same |
| Ownership | `own.json` CAS per cell, `nodes/<node>.json` per node, `wake/` index, waker role | the same ([ownership-and-durability.md](ownership-and-durability.md)) |

[ADR 0001](adr/0001-celld-storage-format-is-native.md) records why this is cellb's only format.

## Bindings keep celld's storage

| Binding | Where its data lives | Implementation |
|---|---|---|
| D1 | a cell `__D1Database:<id>` with the application's tables directly in its SQLite | Miniflare's D1 simulator and workerd's D1 client, vendored |
| KV | a cell `__KvNamespace:<id>`; values above 1 MiB in a FilesApi through celld's blob protocol | celld's `services/kv.js`, vendored unchanged |
| Queues | a cell `__Queue:<id>` with celld's schema (`__queue_messages`, `__queue_stats`, `__queue_meta`, `__queue_transfer_receipts`) | celld's queue code from `harness.js`, vendored unchanged, with the seven policy operations of `celld_logic::queue` ported to TypeScript |
| Workflows | a cell `__Workflow.<script>:<id>`, KV records under `__wf.` plus the instance's alarm | celld's workflow engine from `harness.js`, vendored unchanged |
| R2 | directly in the fleet bucket at `r2/<bucket>/<key>`, metadata in the user-metadata entry `celld-r2`, with an MD5 for a single-request write and none for a multipart object; an open multipart upload in the memory of the node that opened it | cellb's R2 binding on celld's layout; an open upload's parts under `r2-uploads/<bucket>/<uploadId>/` |

`e2e/p11f-celld-one-bucket.test.ts` moves each binding's data celld → cellb → celld through one
bucket. A single Workflow instance takes the whole trip: its first step runs on celld, the step after
its sleep on cellb, the step after its event on celld again, and none runs twice. R2 objects written
by `put` and by multipart upload cross both ways with their metadata.

Without a fleet bucket, R2 keeps its objects in the project's FilesApi. Queues default
`max_concurrency` to celld's ceiling, 250.

[ADR 0002](adr/0002-vendored-celld-javascript.md) records why the vendored code is not rewritten.

## A mixed fleet: cellb as a celld peer (Node)

celld nodes reach a cell's owner through celld's peer protocol (version 5). cellb implements both
sides on Node:

- `startCelldPeerServer({ runtime, store, node })` serves `GET /peer/tunnel` (`Upgrade:
  celld-tunnel`, kinds `do` and `rpc`) and `/peer/probe`. Requests are checked with the fleet's
  HMAC-SHA-256 secret (`fleet/peer-auth.json`), within ±30 s, against a nonce replay cache, for this
  node. A node that does not own the cell answers `409` with `x-cells-route-error: stale-owner`.
- `bucket.advertise(addr)` puts the server's address in the node record, so celld routes requests for
  cellb's cells to it. The probe key is an Ed25519 key; `celld diagnose --peer <node>` reports the
  cellb node as a signed direct probe.
- `celldPeers({ store, node })`, passed as `peers`, routes a cellb Worker's calls for a celld-owned
  cell through the tunnel, fetch, RPC (V8-serialized) and WebSockets alike.

cellb is never a log follower and does not accept capacity hand-off (`/peer/handoff`): it
acknowledges a write only once it is in the bucket, and its node record reports zero placement
weight, so it owns only the cells requested through it.

## Where celld is followed, and where it is not

cellb follows celld, including its deviations from Cloudflare, with these exceptions:

| Behaviour | celld 0.6.3 | cellb |
|---|---|---|
| A nested `dir/index.html` | redirected to `dir/` and then not served (a celld bug) | served, as on Cloudflare; the comparison omits that request |
| Asset paths ending in `/`, except the root | 404 (a celld bug) | as on Cloudflare; unit-tested instead |
| `SELECT` from `_cf_METADATA` | reports `.scope` | reports `.key` |
| A column named `_cf_col`, a string literal `'_cf_x'`, `ALTER TABLE … RENAME TO _cf_t2` | allowed | rejected |
| `new Response("text")` | no `Content-Type` | `text/plain;charset=UTF-8`, as Fetch adds it; aligned in the comparison |
| R2 ETags in `celld dev` | a store generation number | the store's etag; compared by type |
| `storage.put()` of a `ctx.exports.X({ props })` stub or class handle | refused (`function () {} could not be cloned.`) | stored as a V8 host object, as on workerd; celld cannot read it back |
| An `RpcTarget`, function or stub passed through a stub, or into a loaded Worker's `env`, `props` or arguments | refused (`RPC stubs cannot cross isolate boundaries yet.`, `function () {} could not be cloned.`, `Worker Loader env supports only Service Binding capabilities.`) | passed by reference, as on workerd; judged against workerd's recording ([conformance.md](conformance.md#where-cellb-follows-workerd-instead)) |

A Durable Object that keeps out of `_cf_` names sees no difference in the stricter rows.

## What breaks

- **celld reports `ltx file corrupted`** on files another writer produced with header flags 0 and
  zero rolling checksums. cellb writes `NO_CHECKSUM` whenever both checksums are 0; a writer that
  does not cannot hand cells to celld.
- **celld takes over a cell a live cellb node owns.** That happens only when the node record has no
  address or misses a field celld decodes; celld then treats the owner as dead. cellb always writes a
  complete record with an address.
- **celld logs `celld ownership record lost`, and cellb throws `OwnershipRecordLostError`**: see
  [ownership-and-durability.md](ownership-and-durability.md#what-breaks). `celld dev` with a lost
  record reports it and never becomes ready.
- **An R2 multipart upload opened on one runtime cannot be finished on the other.** celld keeps an
  open upload in its node's memory and answers `R2 multipart upload <id> is not open on this node:
  celld can resume an upload within the node that created it, not across nodes or restarts`; cellb
  answers `completeMultipartUpload: The specified multipart upload does not exist. (10024)` for an
  upload celld opened. Complete an upload on the runtime that opened it; the finished object then
  reads on both.
- **Renaming the project's `name` makes every Durable Object start empty.** Ids derive from the
  script name. The old cells are still in the bucket, under their old keys.
- **Node's HTTP server rejects celld's inner RPC requests** with `400`: they carry no `Host` header.
  `startCelldPeerServer` accepts them; another server in front must too.
- **`celld diagnose --peer` reports the probe as failed** on a platform whose WebCrypto lacks Ed25519:
  the node record then carries a random key that cannot sign.
