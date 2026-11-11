# cellb.dev

The monorepo of **cellb** (`@statewalker/cellb`): an isomorphic Durable Objects runtime with a
celld/Cloudflare-compatible surface. The same cells run in a browser (OPFS, ServiceWorker ingress),
in Node, and alongside celld on one shared bucket.

Live demos, each app running in your browser tab: [EmDash served from a
tab](https://cellb-emdash.httpeers.net) and [Astro (EmDash included) built in the
tab](https://cellb-astro.httpeers.net).

## What cellb does, next to celld

[celld](https://github.com/denoland/celld) runs Cloudflare Workers projects on a fleet of servers
that share one bucket. cellb runs the same projects unchanged, in Node and in browsers, answers the
same requests the same way, and stores cells in celld's format, so one cell can be served by celld,
then by cellb, then by celld again. celld is the judge: its examples, cellb's own probe projects and
workerd's Durable Object tests run on the real celld, are recorded, and are replayed against cellb in
Node and in Chromium (70 scenarios; 5 are judged by workerd instead, where cellb passes stubs by
reference as workerd does, and 6 are known differences, listed in
[`packages/cellb/docs/gaps.md`](packages/cellb/docs/gaps.md)).
Each scenario has a page on [cellb.dev/examples](https://cellb.dev/examples) that runs it in your
browser and shows cellb's answers next to the recorded ones.

| Feature | celld 0.6.3 | cellb, Node | cellb, browsers | How cellb is checked |
|---|---|---|---|---|
| Workers (stateless handlers) | supported | yes | yes | `hello`, `webapi`, `router`, `body` |
| Durable Objects / cells | supported | yes, same storage format | yes, same storage format | `counter`, `rpc`, `alarm`, workerd's tests; cells cross celld ↔ cellb |
| Durable Object facets | supported | yes | yes | `facets`, `facets-api` |
| KV | supported | yes (celld's code) | yes | `kv`, `kv-details` |
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
packages/platform/     the webrun apps as Durable Object apps (ESM CDN, user code as ESM, bundler with
                       Astro builds, notebooks), composed into one Worker for Wrangler, celld and cellb
                       (Node and browsers), with its per-host builds and end-to-end checks (see its README)
packages/platform-core/, esm-cdn/, bundler/, astro-builder/, notebooks/
                       the platform's packages (private)
examples/flue/         a Flue agent app (Cloudflare target, Agents SDK) on cellb, in Node and Chromium
examples/agents/       pi and opencode in Durable Objects on cellb, against the fake model
examples/emdash/       EmDash (Astro CMS, Cloudflare build) on cellb, in Node and served statically to a browser
                       (live: https://cellb-emdash.httpeers.net)
examples/astro-in-browser/  Astro apps, EmDash included, built from their sources in a browser tab and run there on cellb
                       (live: https://cellb-astro.httpeers.net)
examples/platform-astro/  a small Astro SSR app the platform bundles, or builds from its sources
examples/platform-demos/  the platform's demos: Astro, EmDash and Observable notebooks bundled, built or compiled
                       by the platform (packages/platform, as in this checkout), run on Wrangler, celld, cellb
examples/fake-openai/  a scripted OpenAI-compatible model endpoint the examples test against
examples/landing/      the page of https://cellb-examples.httpeers.net, which links to the published examples
site/                  the cellb.dev website (Astro, Tailwind CSS, shadcn/ui tokens)
.github/workflows/     ci (cellb's lint, typecheck, unit tests and packed package; on main, the npm release)
                       and interop against the real
                       celld and RustFS, on every pull request; examples (run by hand, on released cellb or
                       on cellb as this checkout would publish it); examples-publish (run by hand: the
                       browser examples' static builds, tested, then published)
.github/dependabot.yml weekly dependency updates, for both workspaces
.changeset/            changesets for the published package (@statewalker/cellb)
```

Two pnpm workspaces. The root one (`pnpm-workspace.yaml`) holds cellb, the platform packages and the
website. The
examples are private apps in a workspace of their own (`examples/pnpm-workspace.yaml`, its own
lockfile) and use cellb as its users do: `@statewalker/cellb` from npm, at a released range
(`~0.8.1`); `@statewalker/fake-openai`, which only they use, is a member of theirs. A change to
cellb reaches the examples through a release: Dependabot raises the range, and its pull request
runs them. Cellb's own storage labs (`ltx-lab`, `sqlite-lab`) are in
`packages/cellb/e2e-browser`. The one exception is `examples/platform-demos`: it checks the platform as it is in this
checkout (`packages/platform`'s build and scripts), so it needs the root workspace installed
too.

## How to run it

Node 24, the version in `.nvmrc` and CI (`nvm use`). Astro, which `site/` and `examples/emdash`
run, refuses Node older than 22.23.4; the cellb package itself runs on Node 22.13 or later.

cellb, at the root:

1. `pnpm install`
2. `cd packages/cellb && pnpm test`: the unit tests (`test/`) and the celld end-to-end tests
   (`e2e/`), which skip without `CELLD_BIN`.
3. `pnpm exec playwright test`: the Chromium end-to-end suite.
4. `pnpm run interop`: the celld interop suite. `scripts/interop-env.sh` downloads the pinned celld
   and RustFS releases and starts RustFS on `127.0.0.1:9200`.
5. `node packages/cellb/scripts/pack-check.mjs`: the package as it would be published.
6. `pnpm --filter @statewalker/cellb-site dev`: the website at `http://localhost:4321`; `build`
   writes it to `site/dist/`.

`pnpm test` at the root runs every workspace's tests, and stops at the first one that fails.

The examples, in `examples/` (`pnpm install` there: they have their own lockfile):

1. `cd flue && pnpm test`: builds a Flue app with Flue's own Cloudflare build and runs it on cellb
   against a fake model endpoint; `pnpm test:browser` runs the same app in Chromium.
2. `cd agents && pnpm test`: pi and opencode, each in a Durable Object on cellb, against the fake
   model.
3. `cd emdash && pnpm test && pnpm test:browser`: EmDash built by Astro, on cellb in Node and as a
   static site in Chromium.
4. `cd astro-in-browser && pnpm test`: the in-browser builder on Node;
   `npx playwright test test/browser/emdash-in-browser.spec.ts` builds EmDash in a Chromium tab.

To try the examples on cellb as it is in this checkout, before a release: pack it
(`pnpm --dir packages/cellb pack`) and add `"@statewalker/cellb": "file:<the .tgz>"` to the
`overrides:` of `examples/pnpm-workspace.yaml`, then `pnpm install --no-frozen-lockfile` in
`examples/` (what the examples workflow does with `cellb: packed`; do not commit it).

## Why it is the way it is

- **One package, three entry points.** Callers differ by platform (isomorphic, Node, browser), not
  by internal module, so `@statewalker/cellb`, `/node` and `/browser` are the seams.
- **CI runs against the real celld.** celld is the conformance judge, so the interop workflow
  downloads the pinned celld and RustFS and runs the Node and Chromium interop suites on every pull
  request. cellb's own checks (`ci.yml`: lint, typecheck, unit tests, the packed package) run
  there too, and gate the release.
- **Examples pin a released cellb.** They show cellb as its users get it, so they run on npm's
  `@statewalker/cellb`, not on this repository's sources: a cellb pull request does not wait on
  them, and an example breaks only by a release it moves to.
- **Examples run by hand, not on every change.** They are whole applications (EmDash built in a
  tab, Flue, pi, opencode) whose jobs take up to 45 minutes, so no push or pull request runs them.
  `examples.yml` runs them on request ("Run workflow", or `gh workflow run examples.yml`), on
  released cellb, or with `-f cellb=packed` on cellb as the chosen branch would publish it; run it
  before a release and after changing an example.
- **Each published example has a host of its own.** `examples-publish.yml` publishes EmDash's
  static build to https://cellb-emdash.httpeers.net and the in-browser builder to
  https://cellb-astro.httpeers.net, with https://cellb-examples.httpeers.net linking to both. Each
  one's ServiceWorker takes its whole origin (EmDash uses absolute `/_emdash/…` paths), so two on
  one host would replace each other.
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
