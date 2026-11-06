---
"@statewalker/cellb": patch
---

A bucket's `close()` waits for a lease renewal that is already on its way to the bucket before it removes the node's lease record, and starts no renewal after. Before, such a renewal could write the record back after the delete, so the node's cells stayed "owned by a live node" until the lease ran out (10 s by default) and the next node could not take them over. The browser partyserver test now restarts on the default lease with no wait, where it used a 1 s lease that made it fence itself under load.
