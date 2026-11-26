---
"@statewalker/cellb": minor
---

"Remove with data" for the fragment hosts (statewalker-root#261): `FragmentHost.remove(id, { withData: true })` deletes `<data>/fragments/<id>/` once the fragment's project is closed, and `joinFragmentShards`' `remove(id, { withData: true })` deletes the fragment's SQLite pool (SQLite WASM's `removeVfs`) and files directory in every shard the tab runs, a disabled fragment's too (not yet isolated Workers' storage, nor the shards other tabs run). On Node, `remove` refuses an id that is not a fragment id when `withData` is set, and an `add` of an id being removed waits for its data to be gone. Added again, the fragment starts from nothing. A plain `remove` keeps the data, as before.
