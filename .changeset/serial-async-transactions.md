---
"@statewalker/cellb": patch
---

An object's async `ctx.storage.transaction()` calls now run one after another, as on workerd. Before, two calls that had both passed the input gate could overlap. Each opened the same savepoint, so when one rolled back it also undid the other's writes.

D1 hit this. Miniflare's D1 object reads each request's body before it starts the request's transaction, so concurrent queries overlapped. EmDash 1.5's first start then failed with `no such table: _emdash_migrations_lock`: a failing read rolled back the `CREATE TABLE` that a concurrent migration had just run.

A `transaction()` awaited inside another transaction's closure nests, as on workerd, wherever async context is available (Node, and engines with `AsyncContext`). Elsewhere, in most browsers today, such a call waits forever: use the closure's `txn` argument there.
