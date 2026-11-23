---
"@statewalker/cellb": patch
---

A fleet node that leaves (SIGTERM, `FleetNode.close()`) answers the requests a client already sent on a kept-alive connection (#222). It dropped its idle connections at once, so a request on its way, sent by a client or load balancer that had not yet seen the node go, was reset (`ECONNRESET`). The node now stops accepting connections, keeps the open ones for 500 ms (within the drain period), and answers each request meanwhile with `Connection: close`.
