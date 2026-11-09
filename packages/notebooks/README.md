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
