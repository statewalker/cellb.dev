---
"@statewalker/cellb": minor
---

Move a project's data to another host (#199). On Node:
- `FragmentHost.exportData(id, { handOver })`, `importData(id, files, { overwrite })`, `handedOver(id)` and `reactivate(id)`;
- `exportCellFiles`, `importCellFiles` and `reactivateCellFiles` for a `loadProject` data directory.

A hand-over marks the source's data: `loadProject`, `add` and `enable` refuse it until it is reactivated or removed with its data, so only one host writes the objects. In browsers, `loadProject(url, { importCells: { files, overwrite } })` writes exported cells into the OPFS pool before any opens, so the cells round-trip browser → Node → browser.

Migration and rollback: a move copies the files and does not transform them, so both hosts must run the same project version. Rolling back means reactivating the source, which kept its data, and discarding the target's copy.
