---
"@statewalker/cellb": patch
---

On a celld bucket, commits are logged from the WAL also for cells without a data directory. `nodeSqliteOpener(undefined, { pageCapture: true })` keeps each cell in a temporary file (not synced, removed when the cell closes or the process exits), so its commits' pages are read from the WAL instead of imaging and diffing the whole database per commit. `loadProject` on Node turns page capture on when its storage logs pages, and Node isolates' facets use it too. The runtime's own databases are never page-captured, and a captured database whose pages nobody reads keeps its WAL bounded.
