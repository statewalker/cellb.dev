# RPC extras: promise pipelining, and globalOutbound in an isolate

Branch `feat/rpc-extras`. Closes two entries of `packages/cellb/docs/gaps.md` ("There is no promise
pipelining"; "A loaded Worker's `globalOutbound` Fetcher does not route its `fetch()` in an
isolate").

## 1. Promise pipelining

**What workerd does.** A call on a stub returns an `RpcPromise`: `stub.a().b()` and
`await stub.a().x.y` work before `a()` has answered, and across isolates `b` is sent at once,
naming `a`'s pending result. cellb returns a native `Promise`, so `stub.a().b` is `undefined`
(`TypeError: stub.a(...).b is not a function`).

**Proof, observable part (recorded, judged by workerd).** The result shape is observable; the
saved round trip is not.

- `worker-details-pipeline` (project `worker-details`, new path `/pipeline`): in one realm,
  `stub.target().inc()` (method on a returned `RpcTarget`) and `stub.nested().inner.n` (property
  path) without `await` in between.
- `isolation-api-pipeline` (project `isolation-api`, new path `/pipeline`): the same across a
  loaded Worker's isolate, both ways — the host on a loaded entrypoint's result, and loaded code on
  a host binding's result.

Both recorded on workerd (the judge, `judge: "workerd"`) and on celld (on file). New paths only:
existing steps and goldens stay as they are.

**Proof, round trips (test at the seam).** `test/p10g-isolate-pipelining.test.ts` drives
`hostPort`/`isolatePort` (`src/isolate/protocol.ts`) over a `MessageChannel` and counts what the
isolate posts while the host is still computing `make()` in `env.factory.make().inc()`: with
pipelining the `inc` call is among them; today nothing is posted until `make()` answers.

**Design.**
- `rpcPromise(result, pipe)` in `src/core/handles.ts`: a thenable Proxy; property reads extend a
  path, a call sends `pipe(path, args)`. The default `pipe` waits for `result` and calls on the
  value (one realm). Used by Durable Object stubs (`namespace.ts`), `asyncStub` (entrypoints,
  facets) and `getEntrypoint()` (`worker-loader.ts`).
- Across the isolate (`callsOver` in `protocol.ts`): a stub call carries an `answer` id; the
  serving side keeps that call's result under it. A call on the pending result is a `ref` message
  naming `{ answer, path }`, sent at once; the serving side awaits the answer and calls on it. The
  answer is released (`release {answer}`) when the caller's result is garbage-collected.
  `asyncStub`, `entrypointStub` and `getEntrypoint` pass such a result through instead of
  awaiting it.

## 2. globalOutbound in an isolate

**Proof (recorded on celld).** `overrideGlobalOutbound` of `worker-loader-test.js` (loaded code's
`fetch()` goes to `ctx.exports.testOutbound`) leaves the vendored skip list
(`scripts/vendor-workerd-tests.mjs` and the generated `wd-worker-loader/index.js`, by hand: same
output, no workerd checkout here). Red today: the isolate fetches the real `https://example.com`.
Its export joins `WL_AGREE` if celld passes it (else `WL_GAPS`). **Re-recorded**, because the
export now runs or the skip lists change: celld and workerd goldens of `wd-worker-loader`,
`wd-worker-loader-gaps`, `wd-worker-loader-stubs`.

**Design.** Both ends of the isolate's multiplexer serve fetch ports (today only the isolate
does). The load message says `outbound: "fetcher"`; the isolate replaces its global `fetch` with
one that opens a port to the host, and the host answers through `WorkerCode.globalOutbound.fetch()`.
`env.__outbound` goes.

## Tasks

1. Harness, red: the two pipelining paths and scenarios, `overrideGlobalOutbound` unskipped;
   recordings; p10g. Red logs `rpc-extras-red.log`, `rpc-extras-p10g-red.log`. Commit with the new
   scenarios marked `knownGap` so the commit is green.
2. Pipelining (`handles.ts`, `namespace.ts`, `worker-loader.ts`, `protocol.ts`, `host.ts`).
   Green: both pipeline scenarios, p10g. Docs: gaps.md, README if a failure mode changes.
3. globalOutbound (`protocol.ts`, `host.ts`, `isolate.ts`). Green: `wd-worker-loader` with
   `overrideGlobalOutbound`. Docs: gaps.md (both outbound entries).
4. Restructure plan §8: a line for each. Merge origin/main, bar (unit, Chromium, Firefox,
   mutate:check, typecheck, Biome), push.

## As built

- The serving side drops an answer when the caller has its result (`release {answer}`, sent on
  arrival), not when the caller's result is garbage-collected: a call on a settled result runs on
  the value already there, so no later message can name the answer.
- A ref on an answer is `ref {on, path, args}`: every call carries its own `answer`.
- `RpcTarget` is branded with `Symbol.for("cellb.RpcTarget")`: a loaded Worker bundles its own
  `cloudflare:workers`, and in an isolate its `RpcTarget`s were copied as plain objects.
- An RpcPromise is an object over `Promise.prototype`, not callable: `node:assert.rejects` calls a
  function it is given (`suggestWorkerBundlerForTypeScriptModules` failed).
- A loaded Worker's entrypoint pipelines one call deep from the host; deeper calls wait for the
  previous one. Stubs across the isolate's port pipeline at any depth.
