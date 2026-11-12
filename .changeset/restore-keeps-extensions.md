---
"@statewalker/cellb": patch
---

node:sqlite driver: `restore()` loads the extensions loaded before (e.g. a cell's `sqlExtensions` such as `sqlite_vec`) into the new connection. A cell restored from a backup lost them: its first `vec_version()` failed with "no such function". SQL still cannot load a library by itself after a restore.

An in-memory driver's `restore()` makes a directory for the database file; `close()` (or process exit) now removes it, where it was left in the temp directory. A connection whose extensions fail to load is closed before the error is thrown.
