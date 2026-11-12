---
"@statewalker/cellb": patch
---

While an async `ctx.storage.transaction()` is open, async storage calls from another event (`get`, `put`, `delete`, `list`, `deleteAll`, alarms) wait until it ends, as that event would on workerd. Before, they ran inside the transaction's savepoint, and its rollback undid their writes. A synchronous write from another event (`sql.exec`, `kv.put`) cannot wait; CellB warns about it once per object. Telling events apart needs async context (Node, or engines with `AsyncContext`).
