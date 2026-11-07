---
"@statewalker/cellb": minor
---

Cells on LTX files (`bucket: { ltx }`) can live on any FilesApi the app opens before it starts its shard workers: a folder on the user's disk (File System Access), memory, OPFS, a key/value store, S3. `files` takes `{ port }` (a FilesApi served with `filesApiPort` / `serveFilesApi`, called over `@statewalker/webrun-rpc` from the store worker) or `{ module, args }` (built in the store worker), besides the `"opfs-sync" | "opfs" | "memory"` presets; `ltxStore: { sab, port }` uses a store the app runs itself (`serveLtxStore`, on the page) instead of a store worker. `ltxCellStore` takes a `room` option for the free-space check and has a `close()` that releases its Web Locks; a store worker that fails to open its FilesApi now fails the shard's start with the reason.

A compaction now moves its new snapshot into place before it removes the files it replaces. It removed them first, so a compaction cut short between the two steps (a closed tab) left only the `.tmp` snapshot, which the next open deleted, and the cell with it. A cell whose compaction stopped after the move opens from the snapshot, and the files it covers are removed.
