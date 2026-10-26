# Plan: the Agents SDK gaps — WebSocket attachments, `env`/`exports` everywhere, `AsyncLocalStorage` in browsers

Branch `feat/agents-sdk-full`. Closes the three Agents SDK entries of `packages/cellb/docs/gaps.md`.
The proof is a recorded conformance project (Node, Chromium bundle, Chromium site), the Flue
example holding a live WebSocket to an agent on Node, and a Chromium spec running an Agents SDK
agent.

## The recorded proof: `conformance/projects/agents-host`

One project, four steps, recorded on celld 0.6.3 and on workerd (Miniflare 4.20260730.0):

| Step | What it reads |
|---|---|
| `/env` | `env.GREETING` while the module is evaluated and later; `exports.Box` and `env.BOX` stubs |
| `/loaded` | a loaded Worker's own `env` (at load and later), its `exports.Echo`, a host stub in its env |
| `/loaded-class` | `env` of `cloudflare:workers` inside a Durable Object class of loaded code (a facet) |
| `ws /ws` | a hibernatable socket's attachment through `WebSocket.prototype.deserializeAttachment.call(ws)`, `ws instanceof WebSocket`, `WebSocket.READY_STATE_OPEN` (what partyserver does) |

celld differs from Cloudflare here: it leaves `env` empty while the module is evaluated, and its
`exports` import is the module's own classes. workerd answers as Cloudflare does, and the Agents SDK
needs that behaviour, so the scenario is `judge: "workerd"` with a `workerdDiffers` note. Red today
on Node: the WS step times out (`agents-sdk-full-p09-red.log`).

## Task 1 — partyserver's WebSocket attachments (gap 1)

partyserver reads attachments with `WebSocket.prototype.deserializeAttachment.call(ws)`, checks
`"OPEN" in WebSocket`, and uses `WebSocket.READY_STATE_*`. In workerd the global `WebSocket` is the
class of both ends of a pair. A Worker's bundle sees the host's `WebSocket` (Node's or the
browser's client class), which has no attachments.

Fix: a Workers global `WebSocket`: a `Proxy` over `CfWebSocket` (the server end's class), so its
`prototype`, `instanceof` and statics are the server end's, whose `construct` makes the host's
client `WebSocket` (`new WebSocket(url)` keeps working). Files: `src/project/workers-globals-module.ts`
(the class), `workers-globals.ts` (inject on Node), `workers-global-names.ts` (browser bundle and
site), `browser-host.ts` and `site.ts` (`workersHostRegistry` entry), `isolate/isolate-worker.ts`.
`src/ws/server.ts` is not touched (another branch works on WebSocket backpressure).

## Task 2 — `env`/`exports` of `cloudflare:workers` in browsers and loaded Workers (gap 2)

One mechanism, `WorkerScope` (moved from `node-project.ts` to `src/project/worker-scope.ts`): `env`
serves the configuration's vars until `bind(runtime)`, then forwards to the runtime's own objects.

- A realm that runs one Worker sets `globalThis.__cellsWorkerScope`, and `cloudflare-workers.ts`
  exports `env`/`exports` forwarding to it: a loaded Worker's isolate (`isolate/isolate.ts`, Node
  thread and browser Dedicated Worker), and a browser project's realm (`browser-host.ts`, both
  `{ bundle }`, through `WORKERS_MODULE_SHIM`, and `{ site }`, through the registry entry).
- Code that shares a realm with another Worker gets a scope of its own: the Node project's bundle
  (as today), Node in-realm loaded code (`nodeModuleLoader`, a scope per bundle), and browser in-realm
  loaded code from Blob URLs (`browserModuleLoader`, a shim per load).
- Not covered: loaded code imported from an in-browser site INTO the project's realm (no
  `isolateScript`). The site's `cloudflare:workers` is one registry entry per realm, so that code
  would read the project's `env`. It stays in `gaps.md`, with that reason.

## Task 3 — `AsyncLocalStorage` in a browser (gap 3)

What the Agents SDK needs: context that survives `await` and stays separate between concurrent
invocations (`agentContext.run(...)` then `getCurrentAgent()` after awaits; `_fiberALS.run` with
`stash()` "correct even with concurrent fibers"; Flue's `ownerStorage`). Chromium 156 and Firefox
157 have no `AsyncContext` (checked, also with `--js-async-context`), and a native `await` never
calls user code, so no shim can follow it. That part is a platform limit.

What can be done, and is: the shim keeps today's behaviour (the store stays set while `run()`'s
promise is pending) and also carries each `run()`'s store through `Promise.prototype.then`
callbacks. Code whose `async`/`await` is compiled to generators (esbuild
`supported: { "async-await": false, "async-generator": false, "for-await": false }`) awaits through
`then`, so its context is exact and separate between concurrent events. `browser-host.md` says how to
build a bundle that way; `gaps.md` keeps the limit for native `await`. Files:
`src/node-compat/async_hooks.ts`, `conformance/browser-bundle.ts` (lowers async for `nodejs_compat`
projects), docs.

## Task 4 — Flue example over a WebSocket (Node proof)

`packages/flue-example`: the app routes `/agents/*` that Flue does not own to the Agents SDK's
`routeAgentRequest`, so a client can open `/agents/flue-assistant-agent/<name>` as a WebSocket. A
new test opens two connections to one agent: each receives the agent's identity and state
messages, a state set by one client reaches the other (partyserver's `webSocketMessage` path, the
one that ignored every message before Task 1). Red before Task 1.

## Task 5 — Chromium: an Agents SDK agent in a browser

An `e2e-browser` spec bundles a small Agents SDK project (`agents` package: one `Agent`
whose `onRequest` awaits, then reads `getCurrentAgent()`) with
`bundleProjectForBrowser`, runs two requests to two agents at once, and checks each saw its own
agent after the await (Task 3), and a WebSocket state message (Task 1). The project lives in
`e2e-browser/fixtures/agents-app/`; `agents` becomes a devDependency of cellb, pinned to the version
Flue brings (0.20.1). If the `agents` package
cannot be bundled for a browser, the spec is not added and the report says why.

## Bar, docs

Docs in the same commits: `gaps.md` (three entries closed or narrowed), `browser-host.md`,
`architecture.md` (the scope), flue-example README. Then the bar (unit, Chromium, Firefox,
mutate:check, typecheck, Biome), `git merge origin/main`, bar, push.
