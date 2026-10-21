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

## celld's own tests

celld's published repository (v0.6.2, also the `candidate` branch) contains **no unit tests
and no conformance fixtures**: `docs/testing.md` describes a differential corpus against
workerd, TLA+ specs and fleet fault injection, but the corpus is not published
(`cfg(celld_internal_tests)` code is stripped). The executable specification available is
therefore celld's **examples** plus its **docs**; both are used here: the examples run
against the real binary, and documented rules (e.g. the cron dialect) became unit tests.

## Results (Node runtime) — 25 projects, all match celld 0.6.2

| Project | Needed |
|---|---|
| hello, webapi, counter, rpc, router, body, async | project loader |
| kv | Miniflare KV simulator (note 16) |
| d1 | Miniflare D1 simulator + workerd client; `exec` split by SQL syntax as celld |
| alarm | alarms (P07a) |
| wsecho | WebSocket hibernation API; Workers `Response`/`WebSocketPair` in user bundles |
| wsclient | outbound WebSocket from a Durable Object (reference server) |
| r2, r2-api (ours) | R2 on a FilesApi |
| queues (+ consumer logs), queues-api (ours) | queue cells, retries, dead-letter queue |
| facets | Worker Loader, `ctx.facets`, `ctx.exports`, `WorkerEntrypoint` props |
| dynamic-worker-tails (logs) | Tail Workers for loaded code (bundle-local console) |
| cron (logs) | Cron Triggers in celld's dialect; 7 unit tests from its documented rules |
| static-assets, assets-api (ours) | assets router, `_headers`, `_redirects`, html_handling, ETag/Range, ASSETS binding |
| workflow, workflow-api (ours) | Workflows: replay, sleeps, events, retries, controls |
| vectordb | `sqlite_vec` flag: sqlite-vec loaded into cell databases (identical distances) |

The comparison also covers **user logs** (`celld dev --logs` `cell_console:` lines vs the
same lines captured from webrun-cells).

### Examples not run, and why

| Example | Blocker here | Path |
|---|---|---|
| python | Pyodide Python Workers | Pyodide in the cell worker (npm `pyodide`), `python_workers` flag |
| wasm | needs the Rust toolchain (`worker-build`) — not installable in this sandbox | runs as plain WASM + JS shim once built |
| container, sandbox | need Docker/Podman | out of scope for browsers |
| pi, opencode | need outbound internet to model endpoints (blocked here) | should run once outbound `fetch` is allowed |

## Differences found in celld (documented, aligned or masked explicitly)

- No `Content-Type` for `new Response("text")` (Fetch adds `text/plain;charset=UTF-8`):
  the test aligns exactly that pair.
- D1 `exec` splits statements by SQL syntax (workerd's client splits on newlines): aligned.
- R2 ETags in dev mode are a store generation number (`"16"`), not MD5: compared by type.
- Queue producer refusals are plain `Error`s; a `text` body is converted with `String()`:
  aligned.
- Workflow durations: strings accept second…year (not "milliseconds"); error text aligned.
- **celld bug:** a nested `dir/index.html` is redirected to `dir/` but never served there;
  webrun-cells follows Cloudflare (unit test) and the comparison omits that request.
- In-process responses get `Content-Length` added by the test, as celld's HTTP server does.

## Not yet covered

- The same corpus in **Chromium** (browser loader for `wrangler.jsonc` projects using
  webrun-modules) — today the browser runs the runtime pieces, not the project loader.
- RPC richness (stubs as arguments, pipelining), PITR, multipart R2, Queues `max_concurrency`.

## Timers

worker-timers is not used for alarms (they run in shard workers, where timers are not
throttled; frozen or closed tabs are handled by the alarm index). It is used for the
WebSocket client heartbeat on a page's main thread (`createWebSocketClass(…, { timers })`).
