---
"@statewalker/cellb": patch
---

Under ownership (a fleet), a cell's container lives with the node's lease on the cell (#225). A node that loses the cell while it keeps running (its lease fenced after a pause or a partition) destroys the cell's container at once, and one that gives the cell back destroys it before the release; before, the container stayed until its inactivity timeout (10 minutes by default) while the new owner ran one of its own. A cell that stays on its node keeps its container across its object's instances, as before.
