---
"@statewalker/cellb": minor
---

`startProjectShards({ bucket })` also takes a function, `(shard) => BrowserBucket`, so that each shard can get its own bucket (#185). This lets shards keep their cells on the page's own FilesApi (a folder, S3, memory): `{ ltx, node, files: { port: filesApiPort(files).port } }` per shard. The MessagePorts in a shard's bucket (`files: { port }`, `ltxStore.port`) are transferred with that shard's init. Before, a function was spread as if it were an object, and the shards silently ran on their own OPFS pools.

More than one shard on one `ltx` storage now works. Each runtime's own databases (`__cellb/alarms`, `__cellb/cron`) are kept as `__cellb/s<shard>/…`, through the new `ownDatabasesScope` option of `browserProjectRuntime`, which `startProjectShards` and `joinProjectShards` set. Before, the second shard waited 20 s on the first one's lock on `__cellb/alarms` and failed. A single runtime keeps the plain names.
