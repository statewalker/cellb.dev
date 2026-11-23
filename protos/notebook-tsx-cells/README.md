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
2. **Type-check** (`src/checkers.ts`, `src/typecheck.ts`): a **plug-in**,
   `buildPage(page, out, { checker })`.
   - A checker takes the page's cells and returns errors as `file:line:column` in the Markdown.
   - Any error stops the build.
   - Three checkers exist:
     - **`reactiveChecker`** (the default) models Observable's semantics:
       - it finds each cell's outputs (top-level declarations) and inputs (names other cells
         define);
       - it writes the cells **in dependency order** into one generated `.tsx` module beside the
         page, so imports resolve as the page's own do, with the real packages' types;
       - each cell becomes a function whose parameters are its inputs, typed as the **values**
         other cells see: a `Mutable<T>` as `T`, a generator or `view(…)` as what it yields, a
         promise as its result;
       - imports are hoisted;
       - every source line keeps its mapping to the Markdown, so an error in a moved cell is still
         reported at its own line.
     - **`pageOrderChecker`** puts all cells in page order in one module. It is simpler, but it
       rejects a cell that uses a name defined further down, and it types a `Mutable` as the
       object.
     - **`noTypeCheck`** checks nothing.
   - The prelude declares the notebook's globals (`display`, `view`, `Mutable`, `width`,
     `invalidation`).
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
- **Reactivity can be typed.** The human's direction (2026-11-23): type checking is pluggable, and
  it must take Observable's reactivity into account. Cells may be reordered by their dependencies
  as long as messages map back to the page.
  - The reactive checker does exactly that.
  - Tests show it accepts a cell that uses a name defined further down, and reads a `Mutable` as
    its value in other cells. The page-order checker rejects both.
  - An error in a reordered cell is reported at its own Markdown line.
  - The demo page has a `Mutable` counter: one cell defines it, a `tsx` cell shows it in a shadcn
    `Button`, and clicking re-runs the reading cell.
  - Limits of the prototype:
    - inputs are found by name, so a local variable that shadows another cell's output inside a
      nested scope is still counted as an input;
    - `viewof`-style names and Observable's `mutable x` syntax are not modelled (notebook-kit uses
      `view()` and `Mutable()`).
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
