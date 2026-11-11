---
"@statewalker/cellb": patch
---

On a celld bucket, commits are logged from the WAL also for cells without a data directory. `nodeSqliteOpener(undefined, { pageCapture: true })` keeps each cell in a temporary file, removed when it closes, so its commits' pages are read from the WAL instead of imaging and diffing the whole database per commit. `loadProject` on Node turns page capture on whenever a bucket is configured.
