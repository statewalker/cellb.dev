# @statewalker/notebook-site-example

Markdown notebooks as an Astro site on cellb. The notebooks become page models (JSON) through
`@statewalker/notebook-build`. The site around them is an ordinary Astro project (`theme/`),
built into one Worker module by [`@statewalker/astro-builder`](../../packages/astro-builder). The
Worker reads the page models from a KV namespace at request time. It runs on cellb, and a static
export of it runs the notebooks' cells in a browser with no server behind it.

The package is private: it is the first step of milestone 8 of the notebook runtime design
(`docs/notebook-runtime/options.md` in statewalker-sandbox), not a library.

## How it fits together

```
notebooks/*.md ──src/page-models.ts──► PageModel per notebook + SiteModel        (JSON)
                 parseMarkdown → resolveNotebook → transpileNotebook  (notebook-build)
                 prose → HTML with heading ids and an outline (markdown-it)
               └► the modules the pages import (notebook-kit's runtime, npm: imports)
                  materialized under /_m/                         → the Worker's static assets

theme/ (Astro) ──astro-builder──► worker.js
   src/live.config.ts      live collections `site` and `notebooks`, read from env.NOTEBOOKS (KV)
   src/pages/[...id].astro prose blocks, one root per code cell, ONE inline module script
   src/layouts/Notebook.astro  navigation, table of contents, styles
   src/pages/api/…         PUT/DELETE page models and the site model (unauthenticated demo)

cellb (wrangler.json: main, kv_namespaces NOTEBOOKS, assets) ──► the site
src/export.ts: pages crawled from the running Worker + assets/ ──► a static site
```

- **Content is data.** A notebook edit is a `PUT` of its page model; the theme is not rebuilt
  and the next request renders the new content.
- **The theme never parses Markdown or transpiles code.** A page model carries rendered prose, the
  cell ids and the module script (`import {define} from "<runtime>"; define(…); …`), which the page
  emits with `<script type="module" is:inline set:html={…}>`.
- **No CDN at run time.** `npm:` imports are pinned to `/_m/<package>@<version>/…` at build time,
  and those files are served by the site itself.
- **The export is pages plus modules.** Modules are imported from JavaScript, so a link crawler
  cannot find them; the export takes them from the materialized closure instead.

## How to use it

Like `examples/astro-in-browser`, it links `@statewalker/webrun-bundler` from a sibling checkout
of webrun-sites (see that example's README). It needs access to registry.npmjs.org.

```
pnpm test        # everything below, in Node, plus Chromium for the export
pnpm typecheck
```

`test/notebook-site.test.ts`:

1. builds the page models of `notebooks/` and materializes their modules;
2. builds `theme/` with astro-builder and runs the Worker on cellb in Node, with KV and assets;
3. checks the rendered pages (title, navigation with the current page, table of contents, heading
   ids, cell roots, the module script verbatim), a 404, and the modules served as assets;
4. edits a notebook through the API and sees the change without a rebuild;
5. exports the site, serves it with a plain Node static file server, and opens it in Chromium: the
   cells run (`42`, `1,234,567.89` from `d3-format`), with no page error and no request off the
   origin.

Chromium: `PW_CHROMIUM`, else `/opt/pw-browsers/chromium` when present, else Playwright's own.

## What will surprise you

- **The page models go in through HTTP**, `PUT /api/site` and `PUT /api/notebooks/<id>`, because
  that is the path an editor would use too. Those endpoints have no authentication.
- **The theme's own `.ts` and `.astro` files are not typechecked**: they are sources for the
  builder, not part of this package's TypeScript project.
- **Prose is still notebook-kit's `md` cells rendered by markdown-it.** Portable Text, the planned
  document format, comes in milestone 3; the page model is the seam it will plug into.
- **Only `js`, `ts`, `ojs` and `sql` cells run.** `html`, `tex` and `dot` cells render as prose,
  as in notebook-build, until their builtins are served without a CDN.

## License

MIT
