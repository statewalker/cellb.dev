# Compatibility with celld

celld (denoland/celld) runs Cloudflare Workers projects on a fleet of servers that share one bucket.
CellB answers the same requests the same way, and stores cells the same way, so one cell can be
served by celld, then by CellB in Node or a browser, then by celld again. This page lists what is
identical, how it is checked, and where the two still differ. The pinned celld version is 0.6.3.

## Features at a glance

| Feature | celld 0.6.3 | CellB, Node | CellB, browsers | How CellB is checked |
|---|---|---|---|---|
| Workers (stateless handlers) | supported | yes | yes | `hello`, `webapi`, `router`, `body` |
| Durable Objects / cells | supported | yes, same storage format | yes, same storage format | `counter`, `rpc`, `alarm`, workerd's tests; cells cross celld ↔ CellB |
| Durable Object facets | supported | yes | yes | `facets`, `facets-api` |
| KV | supported | yes (celld's code) | yes | `kv`, `kv-values` |
| Queues | supported | yes (celld's code) | yes | `queues`, `queues-api` |
| D1 | supported | yes (Miniflare's simulator) | yes | `d1`, D1 migrations |
| R2 | supported | yes, celld's bucket layout | yes | `r2`, `r2-api`, `r2-advanced` |
| Workflows | supported | yes (celld's engine) | yes | `workflow`, `workflow-api` |
| Cron triggers | supported | yes | yes | `cron` |
| Static assets | supported | yes (with Cloudflare's behaviour where celld has bugs) | yes | `static-assets`, `assets-api` |
| Dynamic Workers (Worker Loader) | supported | yes, a worker thread each | yes, a Dedicated Worker each with `isolateScript` (the browser `loadProject` sets it; otherwise the project's realm, [Security](security.md#which-entry-points-isolate-loaded-workers)) | `dynamic-worker-tails`, the Worker Loader scenarios |
| WebSockets, hibernation | supported | yes | yes, over MessagePorts | `wsecho`, `wsclient`, `wd-websocket-*` (celld fails `wd-websocket-hibernation`, CellB passes it) |
| Vectorize-style search | example | yes | yes | `vectordb` |
| Module rules (`.wasm`, `rules`: `CompiledWasm`, `Data`, `Text`) | wrangler bundles them | yes, inlined in the bundle | yes, from `cellb build` (not with `compile`, the site path or `cellbHostModule`) | `p42-module-rules`, `load-project.spec` |
| Workers AI (`ai` binding) | no binding (the `pi` example builds its own adapter) | yes, on an OpenAI-compatible endpoint the host names | yes | `p14-workers-ai`, Flue's `cloud` agent |
| Python Workers (Pyodide) | supported | no, out of scope ([Gaps](gaps.md)) | no | not run |
| Containers | experimental (Docker or Podman) | experimental: `ctx.container` on the host's engine (Wasmer or Lifo, `@statewalker/cellb-containers`) with an image under `cellb.containers` ([Containers](services/containers.md)); reported without either | experimental, the same, in workers | `packages/containers` tests and Chromium e2e; celld's `container` example as `examples/python` |
| Agent frameworks: Flue, pi, opencode | examples (`pi`, `opencode` need the network) | yes, offline against a fake model | Flue | `examples/flue`, `examples/agents` |

## The same request gets the same answer

A project that runs on celld (`wrangler.jsonc` plus its `main`) loads unchanged with
`loadNodeProject` or `browserProjectRuntime`. The conformance corpus runs every project on both and
compares transcripts and user logs ([Conformance](conformance.md)). Behaviours that only show in
those transcripts, and that CellB matches:

- An uncaught error answers `500`, `content-type: application/json`, body
  `Worker failed: rejected: <name>: <message>`. A handler returning something other than a
  `Response` is sent as its text with status 200.
- An inbound request has `request.cf` set to `{}`.
- Non-JS imports follow wrangler's module rules: `import mod from "./add.wasm"` (or
  `./add.wasm?module`) is a compiled `WebAssembly.Module`, as workerd's `CompiledWasm`; `.bin` is an
  `ArrayBuffer` (`Data`); `.txt`, `.html` and `.sql` are strings (`Text`, a BOM kept). The project's
  own `rules` come first, parsed as wrangler does: the first rule of a type without
  `fallthrough = true` closes it, and later rules of that type are dropped with a warning. Other
  rule types (`PythonModule`, a typo) are listed in `unsupported`. `loadProject` on Node and
  `cellb build` inline the bytes as base64 (about 1.33 times the file), so a built folder stays one
  self-contained `worker.js`; a wasm is compiled synchronously when its module is evaluated, as
  workerd imports one (a top-level await would make every importer async, and esbuild's async
  module inits deadlock on circular imports). The rules do not apply to sources compiled
  in a browser (`compile: "bundle"` or `"site"`, `createProjectSite`/`siteCompiler`), nor to
  bundles made with `cellbHostModule` by Vite or another bundler: use that bundler's own wasm or
  raw-import plugin there.
- A promise the Worker leaves rejected concerns the Worker, not the host. celld ignores it and
  workerd logs it. On Node, where the Worker shares the host's process, CellB sends it to
  `onUnhandledRejection` (default: one line on stderr, outside the Worker's console) instead of the
  process's `unhandledRejection` listeners.
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

| Layer | celld | CellB |
|---|---|---|
| Object ids | namespace key `cells:v1:<len(script)>:<script>:<class>`; key = SHA-256(namespace key); id = HMAC(key, name)[0..16] ‖ HMAC(key, first half)[0..16] | the same bytes, computed synchronously |
| Fleet-wide namespaces | KV, D1 and Queues use keys that do not depend on the script | the same |
| Internal tables | `_cf_KV(scope, k, v)`, `_cf_ALARM`, `_cf_METADATA(scope, actor_name)`, `_cf_FACETS`, `_cf_WAKE` and their triggers | the same DDL, plus CellB's own `_cf_LOG` (the changeset log's sequence) |
| Stored values | V8 serialization, version 15 | a TypeScript V8 serializer, byte-identical to Node's on the tested corpus |
| Logs | LTX v3, legacy LZ4 frames, header flag `NO_CHECKSUM`, rolling checksums 0 | the same; the header of a re-encoded celld file is byte-identical |
| Generations | one per owner epoch, starting with a snapshot at TXID 1; restore reads the newest | the same |
| Facets | a database and LTX stream each, at `cells/<root>/facets/<SHA-256(name)[0..16] hex>/ltx/…`, the root's epoch | the same; rows are rescoped to the current run on open |
| Object names | `_cf_METADATA.actor_name` restored as `ctx.id.name` when woken by id | the same |
| Ownership | `own.json` CAS per cell, `nodes/<node>.json` per node, `wake/` index, waker role | the same ([Ownership & durability](ownership-and-durability.md)) |

This is CellB's only format. A cell moves between celld and CellB through one bucket in both
directions without conversion. A converted cell would no longer be byte-identical, and restore
bugs would hide in the converter.

## Bindings keep celld's storage

| Binding | Where its data lives | Implementation |
|---|---|---|
| D1 | a cell `__D1Database:<id>` with the application's tables directly in its SQLite | Miniflare's D1 simulator and workerd's D1 client, vendored |
| KV | a cell `__KvNamespace:<id>`; values above 1 MiB in a FilesApi through celld's blob protocol | celld's `services/kv.js`, vendored unchanged apart from an added export |
| Queues | a cell `__Queue:<id>` with celld's schema (`__queue_messages`, `__queue_stats`, `__queue_meta`, `__queue_transfer_receipts`) | celld's queue code from `harness.js`, vendored unchanged, with the seven policy operations of `celld_logic::queue` ported to TypeScript |
| Workflows | a cell `__Workflow.<script>:<id>`, KV records under `__wf.` plus the instance's alarm | celld's workflow engine from `harness.js`, vendored unchanged |
| R2 | directly in the fleet bucket at `r2/<bucket>/<key>`, metadata in the user-metadata entry `celld-r2`, with an MD5 for a single-request write and none for a multipart object. An open multipart upload: celld keeps it in the memory of the node that opened it; CellB keeps its parts in the bucket under `r2-uploads/<bucket>/<uploadId>/` | CellB's R2 binding on celld's layout |

`e2e/p11f-celld-one-bucket.test.ts` moves each binding's data celld → CellB → celld through one
bucket. A single Workflow instance takes the whole trip: its first step runs on celld, the step after
its sleep on CellB, the step after its event on celld again, and none runs twice. R2 objects written
by `put` and by multipart upload cross both ways with their metadata.

Without a fleet bucket, R2 keeps its objects in the project's FilesApi. Queues default
`max_concurrency` to celld's ceiling, 250.

The vendored code is not rewritten, so that a queue, a workflow instance or a KV namespace that
celld wrote continues on CellB, and back. Miniflare's simulators differ from celld in error
messages, limits and listing, and store nothing in celld's layout. Its D1 simulator is the
exception: celld's D1 cell has the same layout, so CellB uses it.

## A mixed fleet: CellB as a celld peer (Node)

celld nodes reach a cell's owner through celld's peer protocol (version 5). CellB implements both
sides on Node:

- `startCelldPeerServer({ runtime, store, node })` serves `GET /peer/tunnel` (`Upgrade:
  celld-tunnel`, kinds `do` and `rpc`) and `/peer/probe`. Each request must be signed with the
  fleet's HMAC-SHA-256 secret (`fleet/peer-auth.json`), carry a timestamp within ±30 s and a nonce
  not seen before, and be addressed to this node. A node that does not own the cell answers `409`
  with `x-cells-route-error: stale-owner`.
- `bucket.advertise(addr)` puts the server's address in the node record, so celld routes requests for
  CellB's cells to it. The probe key is an Ed25519 key, and `celld diagnose --peer <node>` reports
  the CellB node as a signed direct probe.
- `celldPeers({ store, node })`, passed as `peers`, routes a CellB Worker's calls for a celld-owned
  cell through the tunnel. That covers fetch, RPC (V8-serialized) and WebSockets.

**CellB as a follower in celld's log tier.** In `CELLD_DURABILITY=fleet` (celld's default) a celld
node ships each commit's LTX segment to up to two followers, chosen among every live node record,
and acknowledges the write once they hold it on disk, before the bucket does. A CellB node with a
peer server (`cellb serve`, or `startCelldPeerServer({ follower: createLogFollower(...) })`) is
such a follower:

- `POST /peer/log/append` (`CLA1` frames of `CLE1` entries): it adopts a leader's epoch only when
  the leader's node record names it in an open log of that epoch, accepts entries strictly in
  sequence, and answers `{ok, end, epoch}` only after they are fsynced;
- `POST /peer/log/seal` fences the epoch for good and reports the held range; `POST
  /peer/log/tail` returns it (`CLT2`) to the node that recovers a dead leader;
- the leader's `truncate_to` drops what the bucket holds; a fragment the leader's record has
  closed (recovered, or a later epoch) is dropped every 10 minutes.

The segments are opaque to CellB (L0 LTX files it never reads). They live under `--data` (or a
directory of the node's own under the OS temp dir): give a disk that keeps what was fsynced,
because a celld leader acknowledges on it. A peer server without a follower answers the routes
with 404, and celld quarantines the node from its ensembles for 5 minutes at a time, its
acknowledgements falling back to the bucket meanwhile.

**CellB as a leader, and as a recoverer.** `cellb serve` leads a session of its own unless
`--durability bucket` (`CELLD_DURABILITY`, celld's default `fleet` otherwise), as a celld node
does:

- it recruits up to two live peers, celld or cellb, and opens epoch *n+1* in its node record
  (`log: {state: open, epoch, ensemble, active: false}`, by compare-and-swap through its lease)
  only once nothing it shipped is missing from the bucket;
- it ships each commit's L0 segment to every follower in order and acknowledges the commit when
  all of them hold it, or when its upload lands, whichever is first; `active: true` is applied in
  the record before the first acknowledgement a follower made; uploads stay in TXID order per
  cell, and one the followers acknowledged is retried until it lands;
- any failure degrades the epoch to the bucket's acknowledgements; a follower that cannot append
  (404) is left out for 5 minutes; `truncate_to` follows the bucket;
- SIGTERM stops the shipping, waits for the bucket and seals the session.

A dead leader's session (a celld node's or a cellb node's) is recovered when another node takes
one of its cells, as celld does at the takeover (`ensure_recovered`), and otherwise by a 30-second
sweep on every `cellb serve` node: claim the record (`recovering`), seal the
followers and read their tails, upload what the bucket lacks in TXID order, mark it `sealed`. An
active session needs one complete witness: while a follower that may come back cannot be reached,
the recovery waits; when none is left, the loss is recorded in `log/<session>.e<epoch>.loss.json`.
A session that left node bundles (`log/<session>/bundle/`, celld's tiering) is left to celld.
celld nodes recover dead cellb leaders the same way (e2e `p11n`: a cellb leader whose only
follower is celld, and a fleet of cellb nodes, each killed under load with acknowledged writes
only on its followers; none is lost).

CellB does not accept capacity hand-off (`/peer/handoff`). Its node record reports zero placement
weight and no paced hand-off, so celld neither hands nor rebalances cells to it. A node with a
peer server reports memory headroom: celld's first-readiness gate keeps a starting celld node
unready while a live peer reports pressure. A full celld node may route a new cell to it, which it
serves.

`cellb serve` (or `startFleetNode()` from `@statewalker/cellb/node`) puts the pieces together as a
fleet node, with celld's node flags and environment:

```sh
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
  cellb serve ./my-project --bucket s3://cells/fleet-a --endpoint http://127.0.0.1:9200 \
    --listen 0.0.0.0:8080 --internal-listen 10.0.0.5:7000
```

celld nodes and CellB nodes started this way on one bucket answer as one cluster: a request for
any cell, at any node, reaches the cell's one owner (e2e `p11k-hybrid-cluster` runs 2 + 2 nodes
under load, kills one of each, and checks that no acknowledged write is lost or repeated). What a
mixed fleet relies on:

- **The takeover recovery gate.** In celld's default `CELLD_DURABILITY=fleet`, a celld node
  acknowledges a write once its followers hold it, before it reaches `cells/<cell>/ltx/`. When it
  dies, its node record keeps `log.state` other than `sealed` until a running celld node has
  recovered the log into the cells' prefixes. CellB, like celld (`takeover_gate`), takes none of
  its cells before then: the node that takes one recovers the session first (celld's
  `ensure_recovered`), so a crashed node's cells answer again once its lease has run out (about
  10 s) rather than at the next recovery sweep (up to 30 s later). Meanwhile requests for them
  answer `DurableObjectRoutingError`.
- **An unreachable owner** answers as on celld: `DurableObjectRoutingError: The Durable Object owner
  is currently unreachable`, until its lease expires and the cell moves.
- **The fleet's peer secret** (`fleet/peer-auth.json`) is created by the first node of either
  runtime, with a create-only write.
- **Leaving.** SIGTERM drains the node's requests in flight, releases its cells while its peer
  server still answers (a request routed to it meanwhile is told to re-resolve the owner), then
  deletes its node record, so the other nodes take its cells at once.

## Where celld is followed, and where it is not

CellB follows celld, including its deviations from Cloudflare, with these exceptions:

| Behaviour | celld 0.6.3 | CellB |
|---|---|---|
| A nested `dir/index.html` | redirected to `dir/` and then not served (a celld bug) | served, as on Cloudflare; the comparison omits that request |
| Asset paths ending in `/`, except the root | 404 (a celld bug) | as on Cloudflare; unit-tested instead |
| `SELECT` from `_cf_METADATA` | reports `.scope` | reports `.key` |
| A column named `_cf_col`, `ALTER TABLE … RENAME TO _cf_t2` | allowed | rejected |
| `new Response("text")` | no `Content-Type` | `text/plain;charset=UTF-8`, as Fetch adds it; aligned in the comparison |
| R2 ETags in `celld dev` | a store generation number | the store's etag; compared by type |
| `storage.put()` of a `ctx.exports.X({ props })` stub or class handle | refused (`function () {} could not be cloned.`) | stored as a V8 host object, as on workerd; celld cannot read it back |
| An `RpcTarget`, function or stub passed through a stub, or into a loaded Worker's `env`, `props` or arguments | refused (`RPC stubs cannot cross isolate boundaries yet.`, `function () {} could not be cloned.`, `Worker Loader env supports only Service Binding capabilities.`) | passed by reference, as on workerd; judged against workerd's recording ([Conformance](conformance.md#where-cellb-follows-workerd-instead)) |

A Durable Object that keeps out of `_cf_` names sees no difference in the stricter rows.

## What breaks

- **celld reports `ltx file corrupted`** on files another writer produced with header flags 0 and
  zero rolling checksums. CellB writes `NO_CHECKSUM` whenever both checksums are 0; a writer that
  does not cannot hand cells to celld.
- **celld takes over a cell that a live CellB node owns.** That happens only when the node record
  has no address or lacks a field celld decodes, because celld then treats the owner as dead. CellB
  always writes a complete record with an address.
- **celld logs `celld ownership record lost`, and CellB throws `OwnershipRecordLostError`**: see
  [Ownership & durability](ownership-and-durability.md#what-breaks). `celld dev` with a lost
  record reports it and never becomes ready.
- **An R2 multipart upload opened on one runtime cannot be finished on the other.** celld keeps an
  open upload in its node's memory and answers `R2 multipart upload <id> is not open on this node:
  celld can resume an upload within the node that created it, not across nodes or restarts`; CellB
  answers `completeMultipartUpload: The specified multipart upload does not exist. (10024)` for an
  upload celld opened. Complete an upload on the runtime that opened it; the finished object then
  reads on both.
- **Renaming the project's `name` makes every Durable Object start empty.** Ids derive from the
  script name. The old cells are still in the bucket, under their old keys.
- **Node's HTTP server rejects celld's inner RPC requests** with `400`: they carry no `Host` header.
  `startCelldPeerServer` accepts them; another server in front must too.
- **`celld diagnose --peer` reports the probe as failed** on a platform whose WebCrypto lacks
  Ed25519. The node record then carries a random key that cannot sign.
