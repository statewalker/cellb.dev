---
status: accepted
---

# WebSockets over MessagePorts

A ServiceWorker cannot intercept WebSocket connections, so a page's `new WebSocket(url)` can never
reach a Durable Object in a worker. cellb gives Worker code its own `WebSocket` class, and Durable
Object code its own `WebSocketPair` and a `Response` that accepts status 101, all carrying frames
over a MessagePort. They are installed as the code's globals (through a bundle's injected globals or
the module server's `~deps` proxies); the page's real `WebSocket` is left alone.

## Considered options

- **A real WebSocket server.** None exists in a browser.
- **Replacing `globalThis.WebSocket` in pages.** Rejected: it would also redirect the page's own
  sockets to the internet.

## Consequences

- MessagePorts never report a dead peer, so both ends run a heartbeat and close with `1006` when it
  stops.
- Socket ports must be handed between realms out of band: each shard link has a control port next to
  its HTTP links, and `Upgrade` and `Sec-WebSocket-Protocol` travel as `x-cellb-*` headers because
  the HTTP/1.1 wire and browser `Request`s drop them.
- `bufferedAmount` is always 0.
- The sockets are tested against the platform's own WebSocket on 19 WHATWG behaviours.
