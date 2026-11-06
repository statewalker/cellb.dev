---
"@statewalker/cellb": patch
---

`createWebSocketClass` is `@statewalker/webrun-http-browser`'s client (0.7), and the frames a socket's MessagePort carries are that package's: the server end acknowledges the bytes it dispatched (`{ t: "a", n }`) rather than one message per ack. The ends of a `WebSocketPair` stay cellb's, with workerd's semantics. Over cellb's own client, sockets gain a close-handshake timeout (`closeTimeoutMs`, default 5 s: a server that never echoes the close frame ends the socket with 1006 instead of leaving it closing) and sends that keep their order behind a `Blob`. `heartbeatMs: 0` still turns the heartbeat off, and `timers` may still pass only `setInterval`/`clearInterval`. The server end keeps the heartbeat period of the client's first ping: the package's client announces a longer one when its page turns hidden, which a closing tab does on its way out.
