---
"@statewalker/cellb": patch
---

A WebSocket that celld tunnels to a cell cellb owns opens again when the cell picks a subprotocol: the bridge's socket to the cell now asks for the subprotocols the far client offered. With webrun-http-browser's client (a client refuses a subprotocol it did not ask for), such a socket failed with 1006. Links over ports: once a response is out, a request body the handler took and stopped reading is abandoned after 30 s with no read pending (webrun-http-browser's `requestIdleMs`); a handler that keeps reading keeps it.
