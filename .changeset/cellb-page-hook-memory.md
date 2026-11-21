---
"@statewalker/cellb": patch
---

A browser worker's memory no longer grows with the data its cells write (#184). The SQLite WASM page hook kept a copy of every page a cell wrote until a log took them, but storage that takes no pages never did: an OPFS pool without a bucket, a backup, or a changeset log. A commit now drops those pages, and the runtime's own `__cellb/` databases get no page hook. In Chromium, one page whose 4 workers wrote 6 GiB stays at about 1.7 GB of renderer memory, against 8.3 GB before. `WasmSqliteDriver` takes a fifth argument, `{ pageHook: false }`, for a database whose pages no log takes.
