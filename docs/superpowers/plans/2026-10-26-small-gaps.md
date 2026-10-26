# Small gaps (branch `feat/small-gaps`)

Six entries of `packages/cellb/docs/gaps.md` ("Other gaps", "Planned work"), one commit each, a
red test first where behaviour changes. For each: fix it, or keep it as a platform limit with a
clearer reason. All commands run from `packages/cellb` with
`source ~/.nvm/nvm.sh >/dev/null && eval "$(scripts/interop-env.sh)"; unset RUSTFS_ENDPOINT; export CELLD_BIN ESBUILD_DIR`.
Logs: `$SCRATCH/small-gaps-<task>.log`.

## Decisions taken before coding

- **Item 1, `bufferedAmount`**: webrun-rpc's stream tier gives backpressure to one byte stream
  (`duplexOverPort`), not to a framed, transferable WebSocket port with a close handshake; moving
  sockets onto it would rewrite the router, ServiceWorker and shard paths. Instead the existing
  frame protocol gets one frame, `{ t: "a", n }`: the server end (`CfWebSocket`) acknowledges the
  bytes of each message once it has dispatched it; the client (`CellsWebSocket`) adds each sent
  message's byte size to `bufferedAmount` synchronously (as WHATWG says) and subtracts on ack.
  workerd's server-side WebSocket has no `bufferedAmount`, so the server end gets none. The
  bridges to `ws` in `celld-peer.ts` are not changed.
- **Items 2 and 3 share one proof**: `isolation-api`'s `/facet` (a facet of an isolated class)
  on an OPFS fleet bucket, run A, B, A with A's pool kept, as F0 does for the root.
- **Item 4** overlaps rpc-extras (globalOutbound in isolates): `overrideGlobalOutbound` passes
  only with that routing, and `inheritGlobalOutbound` needs a `.wd-test` globalOutbound wrangler
  cannot express. Only the gaps entry is reworded; `scripts/vendor-workerd-tests.mjs` is not touched.
- **Item 5**: `wd-actor-block-concurrency-timer` agrees with celld (the judge); workerd holds the
  timer. Behaviour stays; the entry is reworded to say cellb follows celld here on purpose.
- **Item 6**: `sql.ingest()` with celld's wording (celld judges). Proof: a new project
  `sql-ingest`, recorded on celld. `wd-sql-default` stays a known gap (celld's answer carries its
  own assert's stack frames), reason reworded.

## Tasks

### T1 — isolated facets in the fleet bucket, rebuilt on acquire (items 2, 3)
- Test (red first): `e2e-browser/opfs-bucket.spec.ts`, after the `facet-store` steps:
  `isolation-api` `/facet` on browser-a (pool kept) → `[1,2]`, browser-b → `[3,4]`,
  browser-a again → `[5,6]`. Red today: browser-b answers `[1,2]` (not in the bucket).
- Fix 2: `src/project/browser-host.ts` passes `storage: () => shared` to `browserIsolatedLoader`.
- Fix 3 (then red at the third step: browser-a serves its old isolate pool): `src/isolate/isolate.ts`
  gives the isolate runtime an `ownership` lease that hands out the epoch the host attached, so
  `ObjectHost` rebuilds the facet's database on acquisition as it does under a lease.
- Command: `pnpm exec playwright test opfs-bucket` (Chromium), then Firefox.
- Docs: drop both gaps entries; README/architecture if they mention it.

### T2 — WebSocket `bufferedAmount` (item 1)
- Test (red first): a case in `test/ws-conformance.ts`, "bufferedAmount: grows by the bytes sent,
  drains to 0", run against native Node, cellb in Node (`test/p07y`) and Chrome/cellb in the
  browser (`e2e-browser/ws-conformance.spec.ts`).
- Fix: `src/ws/frames.ts` (ack frame), `src/ws/client.ts` (count, getter), `src/ws/server.ts` (ack).
- Command: `pnpm vitest run test/p07y test/p07w test/p07x test/p07h`, `pnpm exec playwright test ws-conformance websocket`.
- Docs: drop the gaps entry.

### T3 — `sql.ingest()` (item 6)
- Project `conformance/projects/sql-ingest` (remainders, counts, a syntax error, a refused
  statement, a failure after earlier statements ran); scenario in `conformance/scenarios.ts`;
  `npx tsx conformance/record-celld.ts sql-ingest` → `conformance/golden/sql-ingest.json`.
- Red: `pnpm vitest run test/p09 -t sql-ingest` (`ingest is not a function`).
- Fix: `SqlStorage.ingest` in `src/core/sql-storage.ts`, statement completion in `src/core/sql-split.ts`.
- Docs: gaps table row for `wd-sql-default` reworded; "Planned work" item removed.

### T4 — reword items 4 and 5 in `docs/gaps.md` (no behaviour change).

### Finish
`git merge origin/main`; bar: `pnpm test`, `pnpm e2e`, `pnpm e2e:firefox`, `pnpm mutate:check`,
`pnpm -r typecheck`, `pnpm biome check .`; tick §8 of the restructure plan; push.
