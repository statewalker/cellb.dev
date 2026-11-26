---
"@statewalker/cellb": minor
---

"Remove with data" for the fragment hosts (statewalker-root#261): `FragmentHost.remove(id, { withData: true })` deletes `<data>/fragments/<id>/` once the fragment's project is closed, and `joinFragmentShards`' `remove(id, { withData: true })` deletes the fragment's SQLite pool (SQLite WASM's `removeVfs`), files directory and isolates' storage in every shard the tab runs, a disabled fragment's too. Added again, the fragment starts from nothing. A plain `remove` keeps the data, as before.
