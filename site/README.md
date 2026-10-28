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
| `src/components/` | Header, Footer, Logo, ThemeToggle, CodeBlock (Shiki + copy), HeroVisual, LiveDemo |
| `src/layouts/` | `Base` (theme bootstrap, header/footer) and `Docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/how-it-works` |
| `components.json` | shadcn CLI config, so React shadcn components can be added later (`@astrojs/react` + `npx shadcn add …`) |

## Content map

The copy is drawn from this repository: the root README, `packages/cellb/README.md` and
`packages/cellb/docs/*`.

| Section (home) | Message | Source |
| --- | --- | --- |
| Hero | One cell model for browser, server and cloud; for people and AI agents | root README |
| The architecture | Cells are the unit of the app; placement is a deployment choice. Isomorphic, durable, movable | package README "Why it exists" |
| Where it runs | Browser / Node / celld fleet, one entry point each | architecture.md, browser-host.md |
| Use cases | IDE-class apps (VS Code/Theia-style plugin hosts), AI agents as DOs, sandboxed agent-written code, local-first apps, apps for people and agents, Workers without native binaries | packages/flue-example, packages/agent-examples, Worker Loader docs |
| Code | Node, browser and fleet examples (tabs) | package README |
| Comparison | The full celld 0.6.3 / cellb Node / cellb browsers table, with 70/5/6 scenario counts | the celld comparison table (root README of `ccr-ab3c0d30-6du8do-examples-dir`, not on `main` yet) |
| Life of a cell | Take → run → log → move | ownership-and-durability.md |
| Demo | Web Lock ownership across tabs (the primitive behind browser shards) | browser-host.md |

Docs: `/docs` (getting started: install, entry points, Node, browser, fleet) and
`/docs/how-it-works` (ports, request path, gates, ownership, durability, loaded Workers). The
sidebar links to the repository's reference docs and examples (`src/lib/site.ts` holds the URLs).

## Style

- Shared with celld: the shadcn token contract, Inter / JetBrains Mono, bordered cards, grid
  background, mono eyebrow labels, code windows, comparison tables, CTA band.
- Different: violet (hue ≈ 292) with a magenta secondary. Edit `:root` / `.dark` in
  `src/styles/global.css` to re-skin.

## Open items

- The package is private (v0.0.1, no npm release), so install is "clone the monorepo". Switch
  the hero snippet to `npm i @statewalker/cellb` once it is published.
- Positioning statements (IDE-class apps, people + agents) are the project's vision; the
  feature claims under them are the ones the repository tests.
- Update the comparison table when the root README changes (it is data in `src/pages/index.astro`).
