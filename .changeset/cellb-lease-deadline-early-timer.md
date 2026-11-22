---
"@statewalker/cellb": patch
---

A fleet node's lease deadline timer that fires before the lease's clock reaches the deadline (timers round) is armed again for the rest, instead of leaving the node without a deadline while its renewals are stuck: such a node kept its cells past its lease's validity (statewalker/cellb.dev#212).
