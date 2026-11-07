---
"@statewalker/cellb": minor
---

The ends of a `WebSocketPair` are webrun-http-browser's `ServerWebSocket`, configured for workerd's semantics: either end may `send()` before `accept()`, a close without a code reports 1005, the heartbeat watch starts with the first ping, a closing end still delivers messages, and `goAway()` closes with 1001. The frame protocol over the MessagePort is the package's, so a page's `WebSocket` and a shard's socket speak the same protocol as any other webrun-http-browser server. The public API of `WebSocketPair` and its ends does not change.
