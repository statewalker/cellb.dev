---
"@statewalker/cellb": patch
---

Faster writes in browsers when a cell's storage takes no pages, such as an OPFS pool without a bucket (#194). The SQLite WASM page hook copied every write, and the commit then dropped the copy. The object host now tells the driver whether its storage takes pages, through a new optional `recordPages(on)` on `SyncSqlDriver`, and the hook records nothing when it does not. With 4 workers, writes went from about 181 to about 225 MB/s. A log or bucket still takes every page as before.
