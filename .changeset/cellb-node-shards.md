---
"@statewalker/cellb": minor
---

`@statewalker/cellb/node` exports `startProjectShards({ shards, dir, data?, files? })`: one wrangler project over several worker threads, as `/browser`'s `startProjectShards` runs one over workers (#186). Each thread runs `loadNodeProject` and owns the cells `shardOf(id, shards)` gives it; a port links every two threads, so a Durable Object call from any thread runs in the owner's, and ingress goes round robin. Thread `i` keeps its SQLite files in `<data>/s<i>` (memory without `data`). With `files`, the cells' LTX log goes to that FilesApi, served from the main thread, so a later run with another number of threads opens the cells where the last one left them.
