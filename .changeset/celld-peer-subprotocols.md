---
"@statewalker/cellb": patch
---

A WebSocket that celld tunnels to a cell cellb owns opens again when the cell picks a subprotocol: the bridge's socket to the cell now asks for the subprotocols the far client offered. With webrun-http-browser's client (a client refuses a subprotocol it did not ask for), such a socket failed with 1006. The bridge also drops malformed or (case-insensitively) duplicate subprotocols from the far client's `Sec-WebSocket-Protocol`; if the socket still cannot be made, it answers 400 and closes the cell's port instead of hanging.
