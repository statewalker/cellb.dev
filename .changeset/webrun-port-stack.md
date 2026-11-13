---
"@statewalker/cellb": patch
---

cellb now depends on webrun-rpc 0.11, webrun-streams 0.3, webrun-http-streams 0.5 and webrun-http-browser 0.13. Every webrun transport now runs webrun-rpc's port stack. A multiplexed port's window handshake takes one round trip instead of two, because ports presume the peer's ack once they have seen one. Abandoning a fetched body now releases the producer's stream lock. cellb's own API is unchanged.
