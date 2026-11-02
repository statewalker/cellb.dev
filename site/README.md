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
