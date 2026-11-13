# @statewalker/cellb-notebooks

> Private, not published. Composed by [`platform`](../platform).

## What it is

`NotebookSite`, one Durable Object per site (`/nb/<site>/…`). Markdown notebooks and
[Observable Notebook Kit](https://github.com/observablehq/notebook-kit) documents are compiled
to pages inside the object by `@statewalker/notebook-build`, with linkedom as its DOM. The pages
import notebook-kit's runtime and their `npm:` imports from the site's module server, whose
packages come from the platform's package store.

The demo notebooks are in
[`examples/platform-demos/notebooks`](../../examples/platform-demos/notebooks).

## API

| Request | Answer |
|---|---|
| `PUT /nb/<site>/files/<path>` | writes a notebook (`.md`, Notebook Kit `.html`) or a data file |
| `POST /nb/<site>/import` | replaces the sources: a ZIP, or JSON `{ files: { path: text } }` |
| `POST /nb/<site>/build` | runs the data loaders, builds the pages (incrementally) and the page models → `{ changed, failures, pages, ms, models, modelFailures, loaders, loaderFailures }` |
| `GET /nb/<site>/<page>.html` | a built page; its cells run in the browser |
| `GET /nb/<site>/_m/…` | the npm modules the pages import |
| `GET /nb/<site>/models.json` | the page models of the last build: `{ version, site, pages }` |
| `PUT /nb/<site>/theme` | `{ "build": "<id>" }`: a bundler build of an Astro theme (`POST /builds`) |
| `GET /nb/<site>/t/<page>` | a page rendered by the theme from the page models (`t/` is the home page) |
| `POST /nb/<site>/export` | the themed site as static files, a ZIP (`x-export-pages`, `x-export-modules`) |
| `GET /nb/<site>/search.json` | the search index of the last build: one entry per page section |
| `GET /nb/<site>/[t/]<path>` | a data file: a source file that is not a notebook, or a data loader's output |

## How it works

- `@statewalker/notebook-build` runs in hosted mode, in the object, with linkedom as its DOM.
  Markdown fences and Notebook Kit `<script>` cells become pages whose cells import notebook-kit's
  runtime.
- The pages' `npm:` imports resolve through the site's module server (webrun-modules, packages
  from the package store), at `/nb/<site>/_m/`.
- `@statewalker/notebook-site` serves the pages. `urlpattern-polyfill` covers Node 22, which has
  no `URLPattern`.

## Themed pages

The plain pages have no site around them. A theme adds one: navigation between the notebooks, a
table of contents, the site's styles. A theme is an ordinary Astro project, and
[`theme/`](theme) is the default one.

```
POST /nb/<site>/build ─► pages (as above)
                     └─► page models (src/page-models.ts) ─► nbmeta /models.json
POST /builds  (theme/, built from its sources by the bundler's Astro builder) ─► build <id>
PUT  /nb/<site>/theme { build: <id> }
GET  /nb/<site>/t/<page> ─► the theme's build in a Worker Loader isolate,
                            env.NOTEBOOK_MODELS = { site, pages }  ─► HTML
```

- **A page model** is what a theme needs and nothing more: the notebook's title, its prose as
  HTML (headings with ids), its outline, one entry per code cell, and the module script that
  imports notebook-kit's runtime and calls `define()` for each cell. The theme never parses
  Markdown or transpiles code. The cells are compiled with notebook-build's stages
  (`resolveNotebook`, `transpileNotebook`), the same as the plain pages'.
- **A notebook becomes a document first** (`src/portable-text.ts`): code cells (top-level fences
  whose language is a notebook-kit cell mode, with their fence attributes) and prose between them.
  A Notebook Kit document maps cell by cell, its Markdown cells as prose.
- **`${…}` is taken out of the prose before any Markdown parsing**, by a scanner that knows
  JavaScript strings, template literals and comments, skips code spans and honours `\${`. Markdown
  never sees an expression's source, so `${x*2}` or `` ${html`<b>${x}</b>`} `` stay expressions.
  Each becomes a placeholder that renders as the `<span>` its cell displays into; one that does
  not compile shows its error there. Inside a tag attribute it stays text.
- **Prose is rendered with markdown-it** (images, tables, inline HTML, as the plain pages have
  them). The model also keeps the document as Portable Text (`content`): prose as
  `@portabletext/markdown` blocks with `expr` inline objects, cells as `code-cell` objects, keys
  deterministic at every depth, so the same notebook gives the same models and the same hash.
- **Themed pages read the fence's info string**, which the plain pages ignore:
  - ` ```js echo `: the cell runs, and its source shows under its output;
  - ` ```js run=false `: the source shows, and the cell is not compiled or run;
  - ` ```sql database=warehouse output=rows `: the SQL cell queries `warehouse`, and its rows are
    the variable `rows`;
  - ` ```js hidden `: the cell runs, its output is hidden (a Notebook Kit cell's `hidden`); a
    Notebook Kit cell's `pinned` is `echo`;
  - `${expr}` in prose: a cell of its own, displayed in place in a `<span>`;
  - cells that do not run in a page (`html`, `tex`, `dot`, `python`…) stay inert, as on the
    plain pages: `html` as its markup, the others as code.
- **Content is data.** The models reach the theme in the isolate's `env`, as plain JSON, which
  every host's Worker Loader passes. The isolate is named after the theme's build and the models'
  hash: a notebook edit and a rebuild load the same theme build with new data. The theme is built
  once.
- **The theme reads the models from live collections** (`theme/src/live.config.ts`):
  `getLiveEntry("notebooks", id)` and `getLiveEntry("site", "site")`. One route,
  `src/pages/[...id].astro`, renders every notebook; it emits the module script with
  `<script type="module" is:inline>`, so Astro passes it through unchanged.
- **Paths.** Page paths in the models carry the `/nb/<site>/t` base; the object strips it before
  the theme sees the request. The theme's own files (`/_astro/…`) come from the build's `assets/`.
- **The theme pins `astro` 7.4.4**, so its build does not change under it with each Astro
  release. The platform's Astro demo takes the latest 7.x; between them both places Astro has
  kept its client directives in are checked.

### Search

Each build writes a search index (`src/search.ts`), served at `/nb/<site>/search.json` and named in
the site model (`site.search`):

- **One entry per page section**: the text under a heading, with the heading's anchor. Text above
  the first heading belongs to the page itself. Code cells are left out, and expressions count as
  a space.
- **Collected in the same markdown-it pass that gives headings their ids**, so an entry's anchor is
  always an id the page has.
- **Compact**: `{ pages: [{ path, title }], entries: [{ p, h, a, t }] }`, with up to 2,000
  characters of text per section, fetched whole.

The default theme has a search box in its header. A small inline script loads the index on first
focus, matches every query word against the page title, heading and text (headings weigh more),
and lists up to ten links to `page#anchor`. It needs no library and no CDN.

### Data loaders

A source file named like `data/sales.csv.js` (or `.ts`, `.mjs`) is the data loader of
`data/sales.csv`, as in Observable Framework. Its default export is the data, or a function that
returns it (async allowed):

```js
// quakes.json.js
export default async () => (await fetch("https://example.com/quakes.json")).json();
```

- **A module, not a script.** A Worker or a browser has no process to run and no stdout to read,
  so a loader returns its data: a string, bytes, a Blob or a Response as they are; any other value
  as JSON.
- **Built and run by the platform.** Each build sends a loader to the bundler as a small Worker
  project (`src/data-loaders.ts`). Its npm imports come from the package store. The Worker runs
  once in a Worker Loader isolate, and its `fetch` answers with the data. A loader may use `fetch`.
- **Kept until it changes.** The output is stored in the object (`nbdata`) with the loader's build
  id, a hash of its sources. A rebuild with the same loader reuses the output (`cached: true`), so a
  loader that reads an API is not run again until its source changes, unless the build is
  `POST /nb/<site>/build?loaders=refresh`. A failed loader, or one with no answer in 60 s, keeps its
  last output and is reported in `loaderFailures`, as is a second loader of the same output. Each
  run gets a fresh isolate.
- **Loaders run first**, so a notebook's `FileAttachment("data/sales.csv")` finds the output, as it
  finds any attachment.
- **Served beside the notebooks**, at `/nb/<site>/data/sales.csv` and `/nb/<site>/t/data/sales.csv`.
  A loader's source is never served, since it can hold an API key. Of the sources, only files with
  a data, media or font extension are served (and exported), and never through a dot-file or a
  `.`/`..` segment.
- **Output types are data:** `csv`, `tsv`, `json`, `ndjson`, `txt`, `xml`, `yaml`, `parquet`,
  `arrow`, `sqlite`, `xlsx`, `zip`, images and a few more. `lib/d3.min.js` is not a loader.

Themed pages register the data files their cells name (`registerFile`, notebook-kit's runtime) at
their absolute URLs. So `FileAttachment` resolves the same from `/t/guide/plots` as from
`/t/guide/plots/`, which a static server may redirect to.

### Static export

`POST /nb/<site>/export` returns the themed site as a ZIP that any static file server serves:

- **pages**, crawled from `/nb/<site>/t/` through their links, each saved as `<path>/index.html`;
- **modules**, which a crawler cannot find because the pages import them from JavaScript: the
  closure of the page models' pins (notebook-kit's runtime and the notebooks' `npm:` imports),
  materialized with notebook-build's `materializeDeps`, with the `.css`, `.wasm` and font files
  their packages ship;
- the search index, `nb/<site>/search.json`, which the theme fetches from JavaScript;
- the data files (attachments and data loaders' outputs) at `nb/<site>/t/<path>`, which cells
  fetch from JavaScript;
- a root `index.html` that redirects to `/nb/<site>/t/`.

Paths stay as served (`/nb/<site>/t/…`, `/nb/<site>/_m/…`), so no page is rewritten. One kind of
module is: an `import "./x.css?module"` (notebook-kit's `stdlib/inputs.js` has one) asks the
module server for a JS module, but a static server ignores the query and sends CSS. The export
writes the module server's answer to `x.css.module.js` and points the import there.

The export also carries the notebook-kit built-ins the site's cells use (next section), found
from the cells' free variables (`Inputs`, `Plot`, `d3`…, listed in `x-export-builtins`): their
modules, following static imports, and the assets their packages ship. Their `~esm/` URLs are
replaced by the pinned ones, since a static server cannot redirect. A built-in no cell names
(reached through a computed name, say) is not in the export.

### Built-ins without a CDN

notebook-kit's stdlib loads its libraries from esm.sh: `Inputs`, `htl`, and the recommended
libraries such as `d3`, `Plot`, `tex` or `duckdb`. The site's module server serves them instead
(`src/builtins.ts`):

- in the JS and CSS it serves, `https://esm.sh/<pkg>[@v][/path]` becomes
  `/nb/<site>/_m/~esm/<pkg>[@v][/path]`, a string replacement that downloads nothing;
- a request for a `~esm/` URL resolves the package like any `npm:` import (an unversioned URL
  takes the latest version, as on esm.sh) and redirects to its pinned URL. A package the registry
  does not have redirects to esm.sh.

The rewrite is lazy on purpose: `recommendedLibraries.js` names fifteen libraries, and resolving
them all whenever a page loads it downloads `duckdb-wasm`, `echarts` and the rest for nothing,
which ran celld out of memory.

```sh
curl -X POST -o site.zip localhost:8787/nb/demo/export && unzip site.zip -d site && python3 -m http.server -d site
```

```sh
(cd theme && zip -r - . -x 'node_modules/*') | curl -X POST --data-binary @- 'localhost:8787/builds?tier=object&sourcemap=0'
curl -X PUT -d '{"build":"<id>"}' localhost:8787/nb/demo/theme
open http://localhost:8787/nb/demo/t/
```

Checked by `examples/platform-demos/scripts/e2e.ts … notebooks` on Wrangler, celld and CellB, and
by `packages/platform/scripts/e2e-browser.ts` in a tab.
