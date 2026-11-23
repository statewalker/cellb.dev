---
"@statewalker/cellb": patch
---

A cell of a crashed node answers again once the node's lease has run out (about 10 s). The node taking the cell recovers the dead node's log tier session first, as celld does at the takeover (`ensure_recovered`); before, it waited for a recoverer's sweep, every 30 s, so the cells came back 10 to 40 s after the crash. `celldBucket(…, { recoverDead })` is the hook; `startFleetNode` wires it to its recoverer.
