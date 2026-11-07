---
"@statewalker/cellb": patch
---

Loading `@statewalker/cellb/node` (`loadProject`, `nodeSqliteOpener`, `sqliteObjectStore`) no longer prints Node's "SQLite is an experimental feature" warning. cellb picks `node:sqlite`, not its user, so the warning only added noise on every start. Only that one warning is held back while the module loads; every other warning still prints.
