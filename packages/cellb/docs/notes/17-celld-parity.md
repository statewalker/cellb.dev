# 17 — Parity with celld: same projects, same configuration, same results

**Goal.** A project written for Cloudflare and deployed on celld (`wrangler.jsonc` + its
`main`) runs unchanged on webrun-cells and answers exactly as celld does.

## Method: differential execution against the real celld

- The celld 0.6.2 Linux binary (GitHub release `celld-x86_64-unknown-linux-gnu.gz`) runs
  locally with `celld dev` (local state, esbuild on PATH) — no bucket needed.
- `conformance/celld-examples/`: celld's own examples, byte-identical (Apache-2.0).
  `conformance/projects/`: our projects that exercise APIs more deeply.
- `conformance/scenarios.ts`: a request script per project (HTTP, waits, WebSocket
  sessions); origin, host and named volatile fields are normalized.
- `conformance/record-celld.ts` records `conformance/golden/*.json` from celld;
  `test/p09-celld-conformance.test.ts` loads each project with `src/project/` and requires
  identical transcripts. celld itself tests its compatibility the same way against workerd.

## Results (Node runtime)

| Project | Matches celld | Needed |
|---|---|---|
| hello, webapi, counter, rpc, router, body, async | ✅ | project loader |
| kv | ✅ | Miniflare KV simulator (note 16) |
| d1 | ✅ | Miniflare D1 simulator + workerd client; `exec` split by SQL syntax as celld |
| alarm | ✅ | alarms (P07a) |
| wsecho | ✅ | WebSocket hibernation API (P07h); Workers `Response`/`WebSocketPair` in user bundles |
| r2, **r2-api** (ours) | ✅ | R2 on a FilesApi: ranges, metadata, list with delimiter/cursor/include, multi-delete |
| queues, **queues-api** (ours) | ✅ | queue cells: batches, attempts, retry, `max_retries`, dead-letter queue, delays, limits |
| facets | ✅ | Worker Loader, `ctx.facets`, `ctx.exports`, `WorkerEntrypoint` props |

16/16 projects match.

## Differences found in celld (documented, aligned or masked explicitly)

- No `Content-Type` for `new Response("text")` (Fetch adds `text/plain;charset=UTF-8`):
  the test aligns exactly that pair.
- D1 `exec` splits statements by SQL syntax (workerd's client splits on newlines): aligned.
- R2 ETags in dev mode are a store generation number (`"16"`), not MD5: compared by type.
- Queue producer refusals are plain `Error`s; a `text` body is converted with `String()`:
  aligned.

## Not yet covered

- Corpus examples not run yet: `wsclient` (outbound WebSocket from an object),
  `workflow` (Workflows), `cron` (Cron Triggers), `static-assets`, `dynamic-worker-tails`
  (Tail Workers), `vectordb` (`vec0` SQLite extension), containers/sandbox/python/wasm.
- The same corpus in **Chromium** (browser loader for `wrangler.jsonc` projects using
  webrun-modules) — today the browser runs the runtime pieces, not the project loader.
- RPC richness (stubs as arguments, pipelining), PITR, multipart R2, Queues `max_concurrency`.

## Timers

worker-timers is not used for alarms (they run in shard workers, where timers are not
throttled; frozen or closed tabs are handled by the alarm index). It is used for the
WebSocket client heartbeat on a page's main thread (`createWebSocketClass(…, { timers })`).
