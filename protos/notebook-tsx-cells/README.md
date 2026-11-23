# PROTOTYPE: ts, jsx and tsx notebook cells

Throwaway code for
[statewalker/statewalker-root#236](https://github.com/statewalker/statewalker-root/issues/236),
on the map "Project sites: one standard for every statewalker site". It lives on the branch
`proto/notebook-tsx-cells` and is never merged.

**The question:** can notebook pages carry `ts`, `jsx` and `tsx` cells that run in the browser,
render React (including shadcn components), and are type-checked at build time against the
project's real packages, so that a cell using a removed API fails the build?

## Run it

```bash
pnpm install --ignore-workspace
pnpm build          # page/index.md → dist/
pnpm serve          # build, then serve dist/
pnpm test           # the build seam and the browser seam (headless Chromium)
```

`page/index.md` is the demo page. `test/fixtures/` holds pages that must fail.

## How it works

1. **Parse** (`src/parse.ts`): fenced `js`, `ts`, `jsx` and `tsx` blocks are cells. A fence with
   `run=false` is a snippet, shown and not run. Each cell remembers its Markdown line.
2. **Type-check** (`src/typecheck.ts`): every cell of the page goes, in page order, into one
   generated `.tsx` module beside the page, after a prelude that declares the notebook's globals
   (`display`, `view`, `width`, `invalidation`). The module is checked with the TypeScript compiler
   API, so imports resolve exactly as the page's own imports do, with the real packages' types.
   Each diagnostic is mapped back to `file:line:column` in the Markdown. Any error stops the build.
3. **Emit** (`src/emit.ts`):
   - `ts`/`jsx`/`tsx` cells go through `esbuild.transform` (types erased, JSX to
     `react/jsx-runtime`), then through notebook-kit's `transpileJavaScript`, and run on
     notebook-kit's `NotebookRuntime` (reactive cells, `display`, the inspector).
   - An expression cell is wrapped as `display(__toNode(…))`. `__toNode` is a builtin that mounts
     a React element into a node with `createRoot`.
   - `${…}` in prose becomes an inline cell.
   - esbuild bundles everything into `page.js`: the runtime, the cells, React, the shadcn
     component and `@statewalker/fsm`.

## Findings

- **It works.** All three modes run in Chromium.
  - A shadcn `Button` with React state reacts to clicks.
  - A `tsx` cell renders a table from an `@statewalker/fsm` config.
  - A type error, an import of an export that `@statewalker/fsm` does not have
    (`startProcesses`), and a wrong shadcn prop (`variant="bogus"`) each fail the build at the
    right Markdown line.
- **Typing follows page order, not reactivity.** The check sees cells as one module in page order.
  Observable lets a cell use a name defined later, and gives other cells a `Mutable`'s value rather
  than the object. Neither is modelled. A `Mutable(0)` shown in another cell's JSX failed to
  type-check, so the demo uses React state instead.
  - **(inference)** The standard should say: cells read top to bottom, and React state replaces
    `Mutable` and `viewof` in `jsx`/`tsx` cells.
- **notebook-kit's standard library imports from esm.sh at load time.** DuckDB, Vega, KaTeX,
  Mermaid, Leaflet and others are imported statically, so a page fails to load where esm.sh is not
  reachable. Here they are stubbed (an error on use). The kit must map them to local packages, as
  cellb.dev's notebooks package does, or load the standard library lazily.
- **Bundle size.** `page.js` is 2.2 MB unminified, mostly notebook-kit's whole standard library
  and React. Splitting and minifying are kit work.
- **TypeScript 5 API.** The check uses the `typescript@5` compiler API, because TypeScript 7 has
  none (the same issue as the API-reference research, statewalker-root#234). The kit needs a
  separate tools package on TypeScript 5/6.
- **Not covered here:**
  - styling (Tailwind and the shadcn theme are not compiled, so the button is unstyled);
  - the Astro theme;
  - imports of unpublished workspace packages (this page imports a local `.tsx` file and a
    published package);
  - runtime error positions (only build-time errors are mapped to Markdown lines).
