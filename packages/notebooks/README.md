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
| `POST /nb/<site>/build` | builds the pages (incrementally) → `{ changed, failures, pages, ms }` |
| `GET /nb/<site>/<page>.html` | a built page; its cells run in the browser |
| `GET /nb/<site>/_m/…` | the npm modules the pages import |

## How it works

- `@statewalker/notebook-build` runs in hosted mode, in the object, with linkedom as its DOM.
  Markdown fences and Notebook Kit `<script>` cells become pages whose cells import notebook-kit's
  runtime.
- The pages' `npm:` imports resolve through the site's module server (webrun-modules, packages
  from the package store), at `/nb/<site>/_m/`.
- `@statewalker/notebook-site` serves the pages. `urlpattern-polyfill` covers Node 22, which has
  no `URLPattern`.
