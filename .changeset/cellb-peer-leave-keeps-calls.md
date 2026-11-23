---
"@statewalker/cellb": patch
---

A leaving node's peer server answers the calls other nodes already sent on its pooled tunnels. It dropped its idle tunnels at once, so a call routed to it at that moment failed with "socket hang up" (a 500 at the node that routed it). It now stops accepting tunnels, keeps the open ones for 500 ms and answers with `Connection: close`; its cells are released by then, so such a call is told to re-resolve the owner and lands on the next one.
