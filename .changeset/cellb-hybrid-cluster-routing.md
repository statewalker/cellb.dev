---
"@statewalker/cellb": patch
---

Mixed celld + cellb fleets on one bucket (#208): requests for a cell another node owns now reach that node however they arrive. Events queued on a node whose claim of the cell failed are sent to the owner instead of failing with `ObjectClosedError`; a newer host for the cell is no longer closed by an older request's reroute; when the owner's lease runs out between the failed claim and the owner lookup, the cell is claimed locally, as celld does. An owner that cannot be reached (its process died while its node lease is live) is reported as celld reports it: `DurableObjectRoutingError: The Durable Object owner is currently unreachable` (exported), instead of the socket's error. `celldBucket(...).advertise()` re-arms the lease deadline, so a node whose renewals stop after an advertise still fences its cells (#178).
