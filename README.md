# cellb.dev

The monorepo of **cellb** (`@statewalker/cellb`): an isomorphic Durable Objects runtime with a
celld/Cloudflare-compatible surface. The same cells run in a browser (OPFS, ServiceWorker ingress),
in Node, and alongside celld on one shared bucket.

## What cellb does, next to celld

[celld](https://github.com/denoland/celld) runs Cloudflare Workers projects on a fleet of servers
that share one bucket. cellb runs the same projects unchanged, in Node and in browsers, answers the
same requests the same way, and stores cells in celld's format, so one cell can be served by celld,
then by cellb, then by celld again. celld is the judge: its examples, cellb's own probe projects and
workerd's Durable Object tests run on the real celld, are recorded, and are replayed against cellb in
Node and in Chromium (70 scenarios; 5 are judged by workerd instead, where cellb passes stubs by
reference as workerd does, and 6 are known differences, listed in
[`packages/cellb/docs/gaps.md`](packages/cellb/docs/gaps.md)).

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
| Workers AI (`ai` binding) | no binding | yes, on an OpenAI-compatible endpoint the host names | yes | `p14-workers-ai`, Flue's `cloud` agent |
| Python Workers (Pyodide) | supported | no, out of scope | no | not run |
| Containers | experimental (Docker or Podman) | no; reported in `unsupported` | no | not run |
| Agent frameworks: Flue, pi, opencode | examples (`pi`, `opencode` need the network) | yes, offline against a fake model | Flue | [`examples/flue`](examples/flue), [`examples/agents`](examples/agents) |

Where cellb follows Cloudflare or workerd instead of celld, and what still differs, is in
[`packages/cellb/docs/celld-compatibility.md`](packages/cellb/docs/celld-compatibility.md).

## Layout

```
packages/cellb/        the runtime, its browser host, conformance corpus and docs (see its README)
packages/fake-openai/  a scripted OpenAI-compatible model endpoint, for testing agents offline
examples/flue/         a Flue agent app (Cloudflare target, Agents SDK) on cellb, in Node and Chromium
examples/agents/       pi and opencode in Durable Objects on cellb, against the fake model
docs/superpowers/      plans for work on the repository
.github/workflows/     interop CI against the real celld and RustFS
```

`packages/*` are libraries; `examples/*` are private apps that use them. Both are workspaces
(`pnpm-workspace.yaml`), so an example depends on `@statewalker/cellb` and
`@statewalker/fake-openai` through `workspace:*`.

## How to run it

1. `pnpm install`
2. `cd packages/cellb && pnpm test`: the unit tests (`test/`) and the celld end-to-end tests
   (`e2e/`), which skip without `CELLD_BIN`.
3. `pnpm exec playwright test`: the Chromium end-to-end suite.
4. `cd examples/flue && pnpm test`: builds a Flue app with Flue's own Cloudflare build and
   runs it on cellb against a fake model endpoint; `pnpm test:browser` runs the same app in Chromium.
5. `cd examples/agents && pnpm test`: pi and opencode, each in a Durable Object on cellb, against
   the fake model.
6. `pnpm run interop`: the celld interop suite. `scripts/interop-env.sh` downloads the pinned celld
   and RustFS releases and starts RustFS on `127.0.0.1:9200`.

`pnpm test` at the root runs every workspace's tests, and stops at the first one that fails.

## Why it is the way it is

- **One package, three entry points.** Callers differ by platform (isomorphic, Node, browser), not
  by internal module, so `@statewalker/cellb`, `/node` and `/browser` are the seams.
- **CI runs against the real celld.** celld is the conformance judge, so the interop workflow
  downloads the pinned celld and RustFS and runs the Node and Chromium interop suites on every pull
  request.
- **Examples run offline.** Agent frameworks need a model; the examples point theirs at
  `@statewalker/fake-openai`, so CI needs no key and no network beyond the package registry.

## What will surprise you

- A green `pnpm test` without `CELLD_BIN` says nothing about celld compatibility: those tests skip.
- **`[cellb] …: unhandled rejection in Worker code` lines on stderr** during the conformance run are
  expected: workerd's vendored Durable Object tests leave `assert.rejects(…)` unawaited. A Worker's
  unhandled rejection is its own, as on workerd and celld; cellb reports it there and keeps it from
  the test runner and the process.
- The opencode example's first load takes about half a minute: its SDK bundles to about 430,000
  lines.
