---
"@statewalker/cellb": patch
---

Async `storage.transaction()` calls from concurrent events now run one at a time, so a D1 query that fails no longer rolls back what a concurrent query wrote (EmDash 1.5 migrations on D1).
