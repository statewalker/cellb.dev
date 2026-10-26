# Isolate port on webrun-rpc (F1) and streamed bodies across the isolate (F2)

Branch `feat/isolate-rpc`. Items F1 and F2 of `2026-10-24-cellb-restructure.md` §8; F3 (stubs by
reference) stays out until D10 is decided, and the `RPC stubs cannot cross isolate boundaries yet.`
refusal stays.

**Goal.** A loaded Worker's isolate talks to its host over `@statewalker/webrun-rpc` instead of the
hand-rolled `rpcPort` in `src/isolate/protocol.ts`: errors keep their own properties, and fetch
bodies stream instead of being copied whole with `arrayBuffer()`.

**Proof (recorded on celld 0.6.3, both steps already recorded before any code change):** two new
steps in the `isolation-api` conformance project.

- `GET /error` — a loaded `WorkerEntrypoint` throws `RangeError("refused")` with `code: "E_REFUSED"`;
  celld answers `{name: "RangeError", message: "refused", code: "E_REFUSED"}`. cellb today loses
  `code` (red).
- `GET /stream` — the loaded Worker's response holds its last chunk back for 1 s; the host measures
  the gap between the first and last chunk. celld answers `{firstBeforeLast: true, body: "first;last"}`.
  cellb today buffers the body (red: `firstBeforeLast: false`).

The existing two steps re-record identically (diff empty after `biome format`).

## Design

One `multiplexPort` over the isolate's pipe (Worker / `parentPort`), the host the initiator, the
isolate the responder. The host opens every virtual port; the isolate only accepts:

- one **calls** port (`meta {kind: "calls"}`): `callPort`/`listenPort` with `NO_TIMEOUT` in both
  directions on the same port (requests from one side, replies from the other; a side never sees its
  own posts). This replaces `rpcPort`. The plan text said "a channel per direction"; one port
  carries both directions with no extra code, so one it is.
- (F2) one **fetch** port per request (`meta {kind: "fetch", target}`), carrying HTTP/1.1 over a
  Duplex as `src/transport/port.ts` does (`duplexOverPort` + `fetchOverDuplex` on the host,
  `serveDuplexOverPort` + `serveFetchOverDuplex` in the isolate). The target (`{name}` of an
  entrypoint or `{className, cellKey}` of a facet) rides in the port's `meta`, so the request is not
  touched.

`listenPort` serializes errors with their own enumerable properties (webrun-streams
`serializeError`); `name` lives on the prototype, so the listening side copies it onto the error
before it is serialized, or a `RangeError` would arrive as `Error`.

Node's host-side `Worker` is an EventEmitter (`on("message")`), not a `MessageTarget`: a ten-line
adapter in `protocol.ts` covers it (and `parentPort`, which has `addEventListener`, passes through).

## Tasks

### F1 — isolate port on webrun-rpc

1. Red: add `/error` to `conformance/projects/isolation-api/index.js` and `scenarios.ts`, golden
   from the celld recording. `pnpm vitest run test/p09-celld-conformance.test.ts -t isolation-api`
   fails on `code` (log `isolate-rpc-f1-red.log`).
2. `src/isolate/protocol.ts`: delete `rpcPort`; add `isolatePort(port, side, onCall?)` returning
   `{ call(msg), mux }` built on `multiplexPort` + `callPort`/`listenPort` (`NO_TIMEOUT`), and the
   `PortLike` → `MessageTarget` adapter. `host.ts`, `isolate.ts` switch to it (`rpc.request` →
   `call`, `rpc.send` → `void call(...)`). `isolate-worker.ts` and `node-entry.ts` keep passing
   their port to `serveIsolate`, so both realms use the new port.
3. Green: the same test passes (log `isolate-rpc-f1-green.log`); browser `site-projects` runs
   `isolation-api` through `isolate-worker.ts`.
4. Docs: `docs/gaps.md` (errors keep their properties; remove the F1 item), `docs/architecture.md`
   if it describes the port, plan §8 F1 ticked. Bar, commit, push.

### F2 — streamed bodies

1. Red: add `/stream` (step + golden). Log `isolate-rpc-f2-red.log`.
2. `host.ts`: the facade's `fetch` and the facet `fetch` open a fetch port per request;
   `isolate.ts` accepts fetch ports and answers with `serveFetchOverDuplex`. Delete
   `serializeRequest/Response`, `deserializeRequest/Response` and the `fetch` / `object fetch`
   message types.
3. Green (log `isolate-rpc-f2-green.log`). Docs: `docs/gaps.md` (bodies stream; remove the F2 item),
   plan §8 F2 ticked. Bar, commit, push.

## Bar

`pnpm test` and Chromium `pnpm e2e` with the celld env, `pnpm mutate:check`, `pnpm -r typecheck`,
`pnpm biome check .`. Baseline: 354 passed / 7 expected fail / 1 skipped (unit + e2e), 181 passed /
14 skipped (Chromium); the new steps run inside the existing `isolation-api` cases.

## Follow-up on the same branch (after F1/F2)

Each item: one commit, proven by a workerd-test export moving from a `-gaps` scenario to the agreeing
one (`WL_GAPS` → `WL_AGREE`, `WS_GAPS` → `WS_CONSTRUCTOR_OTHERS` in `conformance/scenarios.ts`),
both goldens re-recorded on celld (only the skip lists change; the per-export answers must stay as
recorded), red on cellb before, green after.

1. [x] **props across the isolate** (`justLoad`; celld "ok", cellb `reading 'props'`).
   `getEntrypoint(name, {props})` reaches an isolated loaded Worker: the facade forwards
   `ctx.props` on calls and fetches; plain-object entrypoint methods receive `(…args, env, ctx)`
   as in workerd (`src/core/handles.ts`, `src/isolate/host.ts`, `src/isolate/isolate.ts`).
2. [x] **`ctx.exports.<Entrypoint>` in loaded Workers** (`ctxExports`; `regressionDeadIoContextGetCode` too, which uses `ctx.exports.X.fetch` directly).
3. **`WorkerCode` module types** (`wasmModules` "ok"; `moduleTypes` matches celld's refusal of
   `data` modules: `module "binary.dat" must be a string or wasm bytes`).
4. **WebSocketPair `binaryType` per project** (`binaryTypeWebSocketPairDefault`,
   `binaryMessageDeliveredAsBlob`, `binaryTypeSwitchMidStream`); `binaryTypeSetterInvalid` and
   `closeReasonUSVString` are the host's own WebSocket/CloseEvent and stay gaps.
`sql.ingest()` is skipped.
