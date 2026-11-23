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
     `react/jsx-runtime`), then through notebook-kit's `transpileJavaScript`.
   - An expression cell is wrapped as `display(__toNode(…))`. `__toNode` is a builtin that mounts
     a React element with `createRoot`.
   - `${…}` in prose becomes an inline cell.
   - **webrun-bundler** bundles the cells with React, the page's own modules (the shadcn button)
     and its packages (`@statewalker/fsm`), through a FilesApi and `nodeModulesPackages()`, with
     `conditions: ["source", "browser"]`. It writes a minified `page.js` (261 KB) with a source map
     back to the original files.
   - **notebook-kit's runtime is not bundled.** An import map points `@observablehq/notebook-kit/runtime`
     at the module server (`/_m/`, **webrun-modules**), so the standard library stays lazy.
4. **Module server** (`src/modules.ts`, `src/site.ts`): webrun-modules wrapped with cellb.dev's
   **`withLocalBuiltins`**. Every `https://esm.sh/…` that notebook-kit names becomes a `/_m/~esm/…`
   URL, resolved to a local npm package the first time a cell uses that library. `pnpm test`
   serves pages this way.
5. **Static export** (`src/export.ts`, `pnpm build` = `--static`): writes `/_m/` as files (83 files,
   520 KB):
   - notebook-kit's runtime and stylesheet, with their static imports;
   - the built-in libraries the cells use, from cellb.dev's **`builtinClosure`**, with the `~esm/`
     redirects replaced by the pinned URLs;
   - `?module` CSS as `.css.module.js`.

   A plain static host then serves the page with no request to any other host. This is what a CI
   build needs.

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
- **esm.sh, solved by reuse.** notebook-kit's standard library imports DuckDB, Vega, KaTeX,
  Mermaid, htl and others from esm.sh. Bundling it would make them eager, and blocking esm.sh
  would break every page. Keeping the runtime unbundled behind webrun-modules + `withLocalBuiltins`
  (served) or `builtinClosure` (static) maps each one to a local package, lazily. A test shows the
  `html` (htl) built-in loads with no esm.sh request.
- **Bundle size.** `page.js` dropped from 2.2 MB to 261 KB minified (React, the button, fsm, the
  cells). The runtime is shared and lazy under `/_m/`.
- **Notebook globals need types.** The checker's prelude declares `html`/`svg` and leaves the other
  recommended libraries (`Plot`, `d3`, `Inputs`, …) as `any`. The kit should take their types from
  their packages.
- **TypeScript 5 API.** The check uses the `typescript@5` compiler API, because TypeScript 7 has
  none (the same issue as the API-reference research, statewalker-root#234). The kit needs a
  separate tools package on TypeScript 5/6.
- **What the kit reuses** (review of webrun-sites and statewalker-knowledge, 2026-11-23):
  - webrun-bundler for bundling;
  - webrun-modules + cellb.dev's `withLocalBuiltins`/`builtinClosure` for the runtime and the
    built-ins;
  - notebook-build once it handles `ts`/`jsx`/`tsx` cells (a fix is in progress in
    statewalker-knowledge);
  - cellb.dev's `portable-text.ts`/`page-models.ts` for `${…}`, fence attributes and page models;
  - Astro's Tailwind integration for CSS.

  The reactive type checker and React mounting are new code.
- **Not covered here:**
  - styling (Tailwind and the shadcn theme are not compiled, so the button is unstyled);
  - the Astro theme;
  - imports of unpublished workspace packages (this page imports a local `.tsx` file and a
    published package);
  - runtime error positions (only build-time errors are mapped to Markdown lines).
