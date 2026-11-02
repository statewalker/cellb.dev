---
"@statewalker/cellb": patch
---

`runtime.close()` lets events still running and `waitUntil` work finish, within `closeGraceMs` (default 2 s), before it closes the databases; their writes are in the final backups. An object's code that uses its storage after that fails with `ObjectClosedError` instead of SQLite's "DB has been closed".
