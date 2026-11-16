---
"@statewalker/cellb": patch
---

A node whose cells were fenced (a lease renewal that failed or landed after the local deadline) takes its cells again on their next event, at the next epoch. The fenced object's lease release no longer races the new object's claim on `own.json`, which refused the cell as "owned by another node" and left it released for celld to take. The fence is re-armed after each lapse, so a cell taken again is fenced by the next one, and the node keeps renewing after a failed renewal instead of stopping for good.
