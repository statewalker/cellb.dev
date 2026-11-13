---
"@statewalker/cellb": minor
---

A project loaded in a browser has `exportCells()`: the cells' databases from its OPFS pool, as `[file name, bytes]`. The names are the ones `nodeSqliteOpener(dir)` gives the same cells, so a data directory on Node (`loadProject(dir, { data })`) starts where the browser's cells are. A project whose cells are not in a pool (a bucket) returns none.
