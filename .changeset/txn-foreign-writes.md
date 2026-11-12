---
"@statewalker/cellb": patch
---

While an async `ctx.storage.transaction()` is open, async storage writes from another event (`put`, `delete`, `deleteAll`, `setAlarm`, `deleteAlarm`) wait until it ends, as that event would on workerd. Before, they ran inside the transaction's savepoint, and its rollback undid them. Reads don't wait, so a transaction can still await a read another event started. A synchronous write from another event (`sql.exec`, `kv.put`) cannot wait; CellB warns about it once per object. Events are told apart through async context (Node, or engines with `AsyncContext`); elsewhere nothing changes.
