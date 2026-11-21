# @statewalker/cellb-site

The cellb.dev website: Astro 5, Tailwind CSS v4 and shadcn/ui tokens, designed as a visual
sibling of [celld.dev](https://celld.dev). It is static; `dist/` can go to any static host.

```sh
pnpm install                   # at the repository root
pnpm --filter @statewalker/cellb-site dev      # http://localhost:4321
pnpm --filter @statewalker/cellb-site build    # static output in site/dist/
pnpm --filter @statewalker/cellb-site check:examples   # runs every example page in Chromium
```

`dev` and `build` first run `scripts/build-examples.ts` (with tsx), which writes the example
pages' data; `pnpm --filter @statewalker/cellb-site examples` runs it alone.

## Structure

| path | purpose |
| --- | --- |
| `src/styles/global.css` | All design tokens (shadcn/ui variable contract), light + dark |
| `src/components/ui/` | shadcn-style primitives as Astro components: Button, Badge, Card |
| `src/components/` | Header, Footer, Logo, ThemeToggle, CodeBlock (Shiki + copy), HeroVisual, LiveDemo, Showcase, Stats |
| `src/layouts/` | `Base` (theme bootstrap, header/footer) and `Docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/how-it-works`, `/docs/from-sources`, `/docs/tools` (the tools built on cellb), `/docs/[...slug]` (the repository's Markdown), `/builders` and `/builders/<kind>`, `/examples` and `/examples/<name>` |
| `src/builders/` | The /builders pages' examples (`examples/<kind>/`), their recorded results (`recorded/<kind>.json`, committed) and the type of those (`types.ts`); `src/lib/builders.ts` lists the pages |
| `scripts/record-builders.ts` | Runs each /builders example against the platform (packages/platform on CellB in Node, port 8787) and writes `src/builders/recorded/` and the screenshots in `public/builders/` (`pnpm record:builders [kind…]`, by hand: it needs the npm registry and Chromium) |
| `scripts/build-examples.ts` | Generates the example pages' data from `packages/cellb/conformance`: `src/generated/examples.json` (sources, requests, recorded answers) and `public/built/<project>/` (each project as `cellb build` writes it). Both are generated, not committed |
| `src/examples/` | The example pages' runner: `run-worker.ts` runs a project in a Dedicated Worker, `reference-server.ts` stands in for the reference server two examples call, `page.ts` compares the answers |
| `src/from-sources/` | The live demo of `/docs/from-sources`: a Hono project bundled in the browser by webrun-bundler and run on CellB |
| `scripts/check-examples.mjs` | Opens every example page of `dist/` in Chromium, presses Run, and fails on an unexpected difference (run in `site.yml`) |
| `src/lib/docs.ts` | Which repository Markdown files become which `/docs/…` pages; the sidebar and `docHref` read it |
| `public/showcase/` | Screenshots from the examples' own test runs (`examples/emdash`, `examples/astro-in-browser`) |
| `components.json` | shadcn CLI config, so React shadcn components can be added later (`@astrojs/react` + `npx shadcn add …`) |

## Content map

The copy is drawn from this repository: the root README, `packages/cellb/README.md` and
`packages/cellb/docs/*`.

| Section (home) | Message | Source |
| --- | --- | --- |
| Hero | One cell model for browser, server and cloud; for people and AI agents | root README |
| The architecture | Cells are the unit of the app; placement is a deployment choice. Isomorphic, durable, movable | package README "Why it exists" |
| Where it runs | Browser / Node / celld fleet, one entry point each | architecture.md, browser-host.md |
| Use cases | IDE-class apps (VS Code/Theia-style plugin hosts), AI agents as DOs, sandboxed agent-written code, local-first apps, apps for people and agents, Workers without native binaries | examples/flue, examples/agents, Worker Loader docs |
| Tools | The ESM CDN, user code as ESM, the bundler, the Astro builder and notebooks: Durable Object apps that run on every host, as what they build does; cards link to each package's page | `packages/platform` and its packages' READMEs |
| Real apps | EmDash in a tab from static files; EmDash built from source in a tab; Flue, pi, opencode | examples/*/README.md |
| Comparison | The full celld 0.6.3 / cellb Node / cellb browsers table, with 70/5/6 scenario counts | root README; each check links to its example page (`src/lib/examples.ts`) |
| Life of a cell | Take → run → log → move | ownership-and-durability.md |
| By the numbers | celld.dev's rows (durability, speed, density and cost) for cellb on Node and Chromium, with footnotes | `packages/cellb/bench/results/*.json`, imported at build time |
| Code | The Durable Object (extends `DurableObject`, `ctx.storage.sql`, RPC through `getByName`) and how Node, a browser (ServiceWorker, shard workers, the page) and a celld fleet run it: the demo's own files, imported raw | `src/demo/counter/` |
| Demo | `src/demo/counter/project` (that Durable Object), built by `scripts/build-examples.ts` into `public/built/demo-counter/` as `cellb build` writes it, and run on cellb shared by every open tab (`joinProjectShards`: the tabs split the project's shards, each a Dedicated Worker with SQLite WASM on OPFS; a ServiceWorker at `/cellb-demo-sw.js`, bundled by `integrations/demo-service-worker.mjs`, routes `/demo/counter-v2/…` to the tab that runs the object). `scripts/check-snippets.mjs` runs the Node side (`serve-node.ts`) | browser-host.md |

Examples: `/examples/<name>` has one page per conformance scenario (the 70 of
`packages/cellb/conformance/scenarios.ts`). Each shows the project's files, links to its source
(celld's repository for celld's examples), and runs it on CellB in a Dedicated Worker of the page,
then puts each answer next to the one celld (or workerd) recorded. The names in the homepage's
comparison table link to these pages. Each project is built
with `buildProject` (the `cellb build` command) into `public/built/<project>/`, and the page's
worker loads it with the browser's `loadProject`, as the "Run it in your app" snippets show.

Docs: `/docs` (getting started: install, entry points, Node, browser, fleet),
`/docs/how-it-works` (ports, request path, gates, ownership, durability, loaded Workers) and
`/docs/tools` (the tools: use cases, HTTP API, how they work, what is checked) are written for the
site. The tools' reference pages (`/docs/tools/<package>`) are the platform packages' READMEs. The reference docs, the service pages (`packages/cellb/docs/services/`) and
the examples' READMEs are the repository's own
Markdown, rendered at build time: `src/lib/docs.ts` lists each file and its page
(`packages/cellb/docs/gaps.md` → `/docs/gaps`), and `src/content.config.ts` loads them as the
`repo` collection. One file, two readers: the same Markdown reads on GitHub and on the site, so
nothing is copied and nothing drifts.

Relative links in that Markdown are written for GitHub (`gaps.md`, `../astro-in-browser`).
`src/lib/rehype-repo-links.ts` rewrites them at build time: a link to a rendered file, or to a
directory whose `README.md` is rendered, goes to its page; any other file (source files, for
instance) goes to GitHub. Link to docs from `.astro` pages with
`docHref("packages/cellb/docs/gaps.md")`, which makes the same choice. To publish another file,
add it to `src/lib/docs.ts`, and add its path to the `paths` filters of
`.github/workflows/site.yml` if it is outside the ones listed there, or an edit to it will not
republish the site.

## Builders

`/builders` is a section with a page per builder of the platform (`packages/platform`): the
ESM CDN, user code as ESM, the bundler, the Astro builder and notebooks. Each page says what the
builder is for and how it works, shows an example's files and the code that uses it, and shows
the results: the platform's answers, request by request, and screenshots of what the example
produced.

The results are recorded, not written by hand. `scripts/record-builders.ts` starts the platform
on CellB in Node from empty storage, sends each page's requests, opens the pages the examples
produced in Chromium and checks them (the chart is drawn, the island hydrates, the input re-runs
the cells), then saves the answers to `src/builders/recorded/<kind>.json` and the screenshots to
`public/builders/`. Both are committed; the site's build reads them and needs no platform. Record
again after changing an example, the platform or its packages:

```sh
pnpm --filter @statewalker/cellb-platform build                 # if packages/platform/dist is stale
PW_CHROMIUM=/path/to/chrome pnpm --filter @statewalker/cellb-site record:builders [esm-cdn|user-code|bundler|astro|notebooks]
```

The ESM CDN, user code and bundler examples are in `src/builders/examples/`. The Astro page uses
`examples/platform-astro` and the notebooks page `examples/platform-demos/notebooks`, which is why
`site.yml` watches those folders.

## Style

- Shared with celld: the shadcn token contract, Inter / JetBrains Mono, bordered cards, grid
  background, mono eyebrow labels, code windows, comparison tables, CTA band.
- Different: violet (hue ≈ 292) with a magenta secondary. Edit `:root` / `.dark` in
  `src/styles/global.css` to re-skin.

## Publishing

`.github/workflows/site.yml` builds the site on every pull request that touches it and publishes
it from `main` to the httpeers static-site host, as
[statewalker/httpeers](https://github.com/statewalker/httpeers) publishes its own sites. A site
there is a first-level prefix of the `sites` bucket on `https://s3.httpeers.net`, named after its
domain; the workflow runs `rclone sync site/dist httpeers:sites/<domain>`, inside that prefix
only, and the host serves it at once (old files for up to 60 s).

Setup, once (repository → Settings → Secrets and variables → Actions):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `HTTPEERS_S3_ACCESS_KEY_ID`, `HTTPEERS_S3_SECRET_ACCESS_KEY` | credentials that can write the site's prefix in the `sites` bucket |
| variable | `SITE_DOMAIN` | optional; `cellb.dev` when unset |

Use credentials of their own, not the pair in `/opt/httpeers/.env` on the httpeers server: that
pair is RustFS's own and is kept in that one file (statewalker/httpeers
`tools/publish/README.md`), and it can rewrite or delete every site in the bucket. A RustFS user
whose policy allows `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on
`sites/cellb.dev/*` only is what this workflow needs; the same key also publishes the browser
examples (`.github/workflows/examples-publish.yml`), so the policy adds `examples.cellb.dev`,
`emdash.cellb.dev`, `astro.cellb.dev` and `containers.cellb.dev`, and the hosts they moved from
(`cellb.httpeers.net`, `cellb-<name>.httpeers.net`), which now serve redirects (published by
`examples-publish.yml`). A redirect cannot carry browser storage across origins: posts a visitor
wrote in EmDash on its old host stay in that host's storage and do not appear on
`emdash.cellb.dev`. The redirect sites also replace the old demos' `/cellb-sw.js` with a worker
that unregisters itself, so a returning visitor is not kept on the old app by its ServiceWorker.

`site/scripts/setup-publish-secrets.sh` does all of it: it reads the root pair over ssh
(`kotelnikov@163.172.46.87`, `HTTPEERS_SSH` to change), creates or re-keys that user (`cellb-site`)
with RustFS's own client (`rc admin`, in a `rustfs/rc` container), checks the new pair can write
and delete under `sites/<domain>/.site/`, and sets the two secrets and `SITE_DOMAIN` with `gh`.
Running it again rotates the key. If it stops at `rc admin`, RustFS refused the admin call; nothing was set on
GitHub.

Without the secrets the workflow builds the site and notes that it did not publish. Run it by hand
with "Run workflow" (`workflow_dispatch`).

### Domains

Everything is served from cellb.dev:

| Host | What | Published by |
| --- | --- | --- |
| `cellb.dev` | the site (with CellB sandbox at `/sandbox/app/` and the Wasmer containers demo at `/demos/containers/`) | `site.yml` |
| `examples.cellb.dev` | the examples' landing page | `examples-publish.yml` |
| `emdash.cellb.dev` | EmDash, served from a tab | `examples-publish.yml` |
| `astro.cellb.dev` | Astro (and EmDash) built in the tab | `examples-publish.yml` |
| `containers.cellb.dev` | both containers demos (the Lifo notebook runs npm code: an origin of its own) | `examples-publish.yml` |

The examples are subdomains, not paths of cellb.dev: EmDash and the Astro builder take their whole
origin (a ServiceWorker at `/`, absolute paths, cookies with `Path=/`), and a demo that runs code
from npm must not share cellb.dev's storage (the sandbox can keep an API key there). Each
subdomain is its own origin (its own storage, ServiceWorkers and permissions); they are one *site*
for the browser (cookies without `Domain` stay on their host, so this matters only for cookies set
with `Domain=cellb.dev`, which nothing here sets).

What the server has, and what a new name needs:

- **DNS** (Gandi): `cellb.dev` and a wildcard `*.cellb.dev`, both an A record to the httpeers
  server (163.172.46.87). A DNS wildcard matches names at any depth (`a.b.cellb.dev` too), so no
  record is needed for a new host.
- **Certificates** (Caddy, in statewalker/httpeers `deploy/Caddyfile`): `cellb.dev` and
  `*.cellb.dev`, both in front of the sites host. A wildcard certificate covers one level only:
  `emdash.cellb.dev` yes, `emdash.s.cellb.dev` no (its TLS handshake fails today).
- **The publishing key** must be allowed to write the host's prefix: add the name to
  `SITE_DOMAINS` in `scripts/setup-publish-secrets.sh` and run it again.

So a new demo at `<name>.cellb.dev` needs only the key's policy, then a publish to
`sites/<name>.cellb.dev`.

#### A deeper wildcard (`*.s.cellb.dev`), if one level is not enough

For many generated hosts (one per user or per session, say) under their own zone such as
`*.s.cellb.dev`, Caddy needs a second wildcard certificate. A wildcard certificate can only be
issued over the DNS-01 challenge, so Caddy needs an API key for the DNS provider:

1. **A Gandi token.** In Gandi's admin, Organizations → *your org* → Sharing → Personal Access
   Tokens: create one with the "Manage domain name technical configurations" permission, limited to
   the cellb.dev domain. Keep it as a secret on the server (e.g. `GANDI_BEARER_TOKEN` in the
   environment of the Caddy container, from the server's `.env`).
2. **Caddy with the Gandi DNS module.** The stock image has no DNS providers; build one with
   [caddy-dns/gandi](https://github.com/caddy-dns/gandi):
   ```Dockerfile
   FROM caddy:2-builder AS builder
   RUN xcaddy build --with github.com/caddy-dns/gandi
   FROM caddy:2
   COPY --from=builder /usr/bin/caddy /usr/bin/caddy
   ```
   (If the httpeers Caddy already issues `*.cellb.dev` over DNS-01, it has a DNS module and token:
   reuse them.)
3. **A site block** in `deploy/Caddyfile`, next to the `*.cellb.dev` one:
   ```caddyfile
   *.s.cellb.dev {
     tls {
       dns gandi {env.GANDI_BEARER_TOKEN}
     }
     reverse_proxy sites:3000
   }
   ```
   then deploy (`docker compose up -d caddy`, or the httpeers deploy script). Caddy logs
   `certificate obtained successfully` for `*.s.cellb.dev`.
4. **DNS**: nothing to add, the `*.cellb.dev` record already answers for `x.s.cellb.dev`. (To
   point the zone elsewhere later, add an explicit `*.s.cellb.dev` record.)
5. **Check**: `curl -sI https://test.s.cellb.dev/` answers (`404 not found` from the sites host
   until something is published there), and `openssl s_client -connect test.s.cellb.dev:443
   -servername test.s.cellb.dev </dev/null | openssl x509 -noout -subject` shows
   `CN = *.s.cellb.dev`.

Without a wildcard, Caddy can also get one certificate per name over HTTP-01: list the names in a
site block (`a.s.cellb.dev, b.s.cellb.dev { reverse_proxy sites:3000 }`), or use Caddy's
on-demand TLS with an `ask` endpoint that allows only the published hosts. Both avoid the DNS
token; both issue a certificate per host (Let's Encrypt allows 50 new ones per registered domain
per week).

## Updating the numbers

The "By the numbers" table reads `packages/cellb/bench/results/node.json` and `chromium.json`
when the site is built. To refresh them, from `packages/cellb`:

```sh
BENCH_JSON=bench/results/node.json pnpm bench
BENCH_JSON=bench/results/chromium.json pnpm bench:browser
```

Then rebuild the site. The footnotes name the machine from `node.json`; record both files on the
same machine.

## Open items

- Positioning statements (IDE-class apps, people + agents) are the project's vision; the
  feature claims under them are the ones the repository tests.
- Update the comparison table when the root README changes (it is data in `src/pages/index.astro`).
- The recorded numbers come from one 4-vCPU Linux VM. A run on the hardware the project wants to
  quote (and against a real S3 bucket for the durable-write row) would replace them.
