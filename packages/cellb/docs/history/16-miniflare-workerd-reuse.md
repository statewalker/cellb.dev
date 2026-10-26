# 16 — What can be reused from Miniflare (2, 3, 4) and workerd for DOs / "celld" in the browser

Sources inspected: cloudflare/workers-sdk@d0359e0 (packages/miniflare, Miniflare 4),
cloudflare/miniflare branch v2 (Miniflare 2, pure TypeScript), cloudflare/workerd@2e36a38.

## 1. The three generations

| | Miniflare 2 (≤ 2.14) | Miniflare 3 (2023–24) | Miniflare 4 (current) |
|---|---|---|---|
| Executes Worker code with | Node `vm` (`runner-vm`) | workerd (C++/V8) child process | workerd |
| Binding implementations | TS classes in Node over a `Storage` abstraction | first Node "gateways", then simulator Durable Objects | **simulator Durable Objects written for workerd** (`src/workers/**`) |
| Node-side code | everything | config → workerd Cap'n Proto, loopback server, dev registry | same |

The runtime part of Miniflare 3/4 cannot run in a browser (it spawns `workerd`). What *can*
is the code that itself runs **inside** workerd — and that is exactly what webrun-cells
emulates.

## 2. Miniflare 4: the simulator Durable Objects — reusable unchanged (verified)

`packages/miniflare/src/workers/` contains ~146 TypeScript files executed by workerd:
the bindings' backends are ordinary Durable Objects (`MiniflareDurableObject extends Router`)
on `ctx.storage.sql`, with values in a blob store reached through a `MINIFLARE_BLOBS`
service (workerd's disk-directory service).

| Simulator | External needs | Status here |
|---|---|---|
| KV (`kv/namespace.worker.ts`) | node:assert | ✅ **runs unchanged** (Node 6 tests + Chromium) |
| D1 (`d1/database.worker.ts`) | node:assert, zod | ✅ **runs unchanged** (Node 3 tests + Chromium) |
| R2 (`r2/bucket.worker.ts`) | + node:buffer, node:crypto `createHash` (MD5/SHA for checksums) | likely — needs a `createHash` shim (@noble/hashes) |
| Cache (`cache/cache.worker.ts`) | + http-cache-semantics | likely |
| Queues broker (`queues/broker.worker.ts`) | + kleur, timers, service bindings to consumers | needs consumer dispatch wiring |
| Rate limit (`ratelimit/*`) | none | likely |
| Workflows | `@cloudflare/workflows-shared` (the engine is itself a DO in TS, uses alarms) | after alarms (P07) |
| Email, secrets-store, analytics-engine | small | not checked |

What the reuse needed (all in `src/miniflare-compat/`, built by `scripts/vendor-miniflare.mjs`
into `vendor/miniflare/*.js`):

- **Shims for workerd specifics:** `node:assert`; `node:buffer` → `buffer`;
  `IdentityTransformStream`; BYOB `readAtLeast`; workerd's **integer-millisecond
  `performance` clock** (Miniflare does `BigInt(performance.timeOrigin + performance.now())`,
  which throws on fractional browser/Node clocks — injected bundle-locally, the real global
  is untouched); `Cloudflare.compatibilityFlags`; `cloudflare-internal:*` modules.
- **Runtime features webrun-cells lacked:** `ctx.storage.sql.prepare()` (workerd API used by
  Miniflare's typed SQL), `request.cf` on `stub.fetch` (Miniflare passes the object's name
  in `cf.miniflare.name`), PITR bookmark methods (D1 asks for
  `storage.getCurrentBookmark()` as a session commit token — implemented as opaque,
  ordered tokens; no restore yet).
- **A blob service on webrun-files:** `filesApiBlobService(files)` implements the disk
  service protocol (PUT/GET with Range/HEAD/DELETE) on any FilesApi — OPFS in the
  browser. It must accept workerd-style stream bodies without `duplex: "half"`.
- **Binding clients:** in workerd the KV and R2 bindings are **native C++** clients of the
  simulators, so KV needed a small TS client (`kvNamespaceBinding`, wire protocol of
  `namespace.worker.ts`; list metadata must be JSON-parsed as workerd does). D1 needed
  **nothing**: see §4.

## 3. Miniflare 2: pure TypeScript, partly reusable

| Package | LOC | Reuse |
|---|---|---|
| `durable-objects` | 2040 | already the skeleton of webrun-cells (ids, gates, alarm store) |
| `core/standards` | part of 5658 | polyfills of workerd extensions: `IdentityTransformStream`, `FixedLengthStream`, `readAtLeast`, `DigestStream`, `crypto.subtle.timingSafeEqual`, MD5, `navigator`, `scheduler.wait` — **useful as shims** for more simulators |
| `kv`, `r2`, `cache`, `d1` | 485 / 1893 / 536 / 730 | binding *clients* over a storage interface; superseded by the Miniflare 4 simulators (more complete, maintained) — useful as reference for clients workerd implements in C++ (KV, R2) |
| `web-sockets` | 567 | `WebSocketPair` for Node `ws`; webrun-cells has its own (MessagePorts) |
| `scheduler` | 158 | cron triggers (cron parsing) — reusable for `scheduled` handlers |
| `html-rewriter` | 115 | `HTMLRewriter` on `html-rewriter-wasm` (lol-html in WASM) — **browser-capable**, worth reusing |
| `runner-vm`, `http-server`, `storage-*`, `watcher` | — | Node only, not reusable |

## 4. workerd: what is not C++

workerd itself is C++ around V8; there is no WASM build, so the runtime cannot run in a
page. Its JavaScript/TypeScript layers:

- **`src/cloudflare/internal/*-api.ts` — binding clients in TS** (D1, Vectorize, AI, AI
  Gateway, Images, Workflows, Hyperdrive, Browser Rendering, to-markdown). They wrap a
  `Fetcher` and speak HTTP to a backend. **Verified: `d1-api.ts` runs unchanged** against
  Miniflare's D1 simulator: `exec`, `prepare/bind/run/all/first/raw`, atomic `batch`
  (a UNIQUE violation rolls the whole batch back), D1 error messages, BLOBs.
- **`src/node/*.ts` — `node:*` modules**: TypeScript, but built on `node-internal:*` C++
  primitives; porting them means re-implementing those internals. For Node compatibility
  in the browser prefer **unenv** (workers-sdk `packages/unenv-preset`, the same polyfill
  set Wrangler uses for Workers).
- Cap'n Proto config, the V8 isolate model, CPU/memory limits, I/O gates in C++ — not
  reusable; webrun-cells re-implements the semantics (P03, P05).

## 5. Verified in this session

| Test | Where | Result |
|---|---|---|
| `test/p08a-miniflare-kv.test.ts` | Node | 6/6: get/put/delete (text, json, arrayBuffer), metadata, URL-unsafe keys, list pagination, Miniflare's own validation (expirationTtl < 60 → 400), values in the FilesApi blob store, use from a Worker via `env` |
| `test/p08b-miniflare-d1.test.ts` | Node | 3/3: see §4 |
| `browser/e2e/miniflare.spec.ts` | Chromium | KV + D1 in a Dedicated Worker on OPFS (sahpool SQLite + OPFS blob store), state survives a worker restart |

## 6. Recommendation

1. **Adopt Miniflare 4's simulators as the bindings of webrun-cells** (KV, D1 now; R2,
   Cache, Rate limit next; Queues and Workflows after alarms). They are maintained by
   Cloudflare, match production semantics, and run on the same DO API webrun-cells provides
   — so they also run on **celld** unchanged, which keeps the "browser or celld, same code"
   goal.
2. **Adopt workerd's TS binding clients** where they exist (D1 today; Vectorize, AI,
   Workflows, Images as needed); write small TS clients only where workerd's are native
   (KV done; R2 next).
3. Take Miniflare 2's `core/standards` polyfills and `html-rewriter` (WASM) for the
   remaining workerd-specific APIs.
4. Keep the vendoring reproducible (`MINIFLARE_SRC=… WORKERD_SRC=… node
   scripts/vendor-miniflare.mjs`, commits pinned in the bundle headers) and re-run the
   tests on each upgrade — the simulators use workerd details (e.g. the integer clock) that
   can change.

## 7. Open threads

- Bindings in user code loaded by webrun-modules: expose `env.KV`/`env.DB` objects built
  from these clients when the runtime reads `wrangler` config.
- Simulator objects are ordinary cells: they shard, back up and fail over like user objects;
  decide whether binding objects get their own shard space.
- Licences: workers-sdk (MIT OR Apache-2.0) and workerd (Apache-2.0) — keep headers and add
  NOTICE entries when publishing.
