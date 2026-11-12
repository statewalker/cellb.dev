---
"@statewalker/cellb": patch
---

node:sqlite driver: `restore()` loads the extensions loaded before (e.g. a cell's `sqlExtensions` such as `sqlite_vec`) into the new connection. A cell restored from a backup lost them: its first `vec_version()` failed with "no such function". SQL still cannot load a library by itself after a restore.
