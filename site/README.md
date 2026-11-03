# @statewalker/cellb-site

The cellb.dev website: Astro 5, Tailwind CSS v4 and shadcn/ui tokens, designed as a visual
sibling of [celld.dev](https://celld.dev). It is static; `dist/` can go to any static host.

```sh
pnpm install                   # at the repository root
pnpm --filter @statewalker/cellb-site dev      # http://localhost:4321
pnpm --filter @statewalker/cellb-site build    # static output in site/dist/
```

## Structure

| path | purpose |
| --- | --- |
| `src/styles/global.css` | All design tokens (shadcn/ui variable contract), light + dark |
| `src/components/ui/` | shadcn-style primitives as Astro components: Button, Badge, Card |
| `src/components/` | Header, Footer, Logo, ThemeToggle, CodeBlock (Shiki + copy), HeroVisual, LiveDemo, Showcase, Stats |
| `src/layouts/` | `Base` (theme bootstrap, header/footer) and `Docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/how-it-works` |
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
| Real apps | EmDash in a tab from static files; EmDash built from source in a tab; Flue, pi, opencode | examples/*/README.md |
| Code | Node, browser and fleet examples (tabs) | package README |
| Comparison | The full celld 0.6.3 / cellb Node / cellb browsers table, with 70/5/6 scenario counts | root README |
| Life of a cell | Take → run → log → move | ownership-and-durability.md |
| By the numbers | celld.dev's rows (durability, speed, density and cost) for cellb on Node and Chromium, with footnotes | `packages/cellb/bench/results/*.json`, imported at build time |
| Demo | Web Lock ownership across tabs (the primitive behind browser shards) | browser-host.md |

Docs: `/docs` (getting started: install, entry points, Node, browser, fleet) and
`/docs/how-it-works` (ports, request path, gates, ownership, durability, loaded Workers). The
sidebar links to the repository's reference docs and examples (`src/lib/site.ts` holds the URLs).

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
| variable | `SITE_DOMAIN` | optional; `cellb.httpeers.net` when unset |

Use credentials of their own, not the pair in `/opt/httpeers/.env` on the httpeers server: that
pair is RustFS's own and is kept in that one file (statewalker/httpeers
`tools/publish/README.md`), and it can rewrite or delete every site in the bucket. A RustFS user
whose policy allows `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on
`sites/cellb.httpeers.net/*` and `sites/cellb.dev/*` only is what this workflow needs.

`site/scripts/setup-publish-secrets.sh` does all of it: it reads the root pair over ssh
(`kotelnikov@163.172.46.87`, `HTTPEERS_SSH` to change), creates or re-keys that user (`cellb-site`)
with RustFS's own client (`rc admin`, in a `rustfs/rc` container), checks the new pair can write
and delete under `sites/<domain>/.site/`, and sets the two secrets and `SITE_DOMAIN` with `gh`.
Running it again rotates the key. If it stops at `rc admin`, RustFS refused the admin call; nothing was set on
GitHub.

Without the secrets the workflow builds the site and notes that it did not publish. Run it by hand
with "Run workflow" (`workflow_dispatch`).

`cellb.httpeers.net` needs nothing else: the zone has a wildcard DNS record and Caddy a wildcard
certificate. To move the site to `cellb.dev`:

1. In statewalker/httpeers, add a site block to `deploy/Caddyfile` that sends the name to the
   same host as the wildcard, and deploy it: `cellb.dev { reverse_proxy sites:3000 }` (Caddy gets
   its certificate over HTTP-01, as the name is not a wildcard).
2. Point `cellb.dev` at the httpeers server (an A record, and AAAA if the server has IPv6). `.dev` is HTTPS-only in every
   browser, so the site loads once Caddy has the certificate.
3. Set the variable `SITE_DOMAIN` to `cellb.dev` and run the workflow. The old prefix,
   `cellb.httpeers.net/`, stays served until it is removed (`httpeers-publish --delete-site`).

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
