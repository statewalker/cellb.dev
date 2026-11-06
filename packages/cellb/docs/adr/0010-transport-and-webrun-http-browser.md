---
status: accepted
---

# What cellb takes from webrun-http-browser

`@statewalker/webrun-http-browser` 0.7 grew out of cellb's own ServiceWorker and WebSocket layer
(statewalker/webrun-wire#37): HTTP links over MessagePorts, a ServiceWorker dispatcher with
pluggable routing, handlers in Dedicated Workers, re-linking after a restart, liveness through Web
Locks, and WebSockets carried by ports. cellb takes from it what it can use without losing
anything it has, and keeps the rest until the package can carry it (#18).

## From the package

- **The WebSocket client** (`createWebSocketClass`) and **the frames on a socket's port**
  (version 2: byte-counted acks, a close timeout). cellb's `createWebSocketClass` is a thin
  adapter that keeps its options. The client announces a longer heartbeat period when its page
  turns hidden; cellb's server end keeps the first one, because a tab that closes turns hidden on
  its way out and would otherwise be noticed dead only after 3.5 minutes
  (`websocket.spec.ts`, "the server side notices a client tab that died").

## Still cellb's, and what would let the package take it

- **The ends of a `WebSocketPair`** (`CfWebSocket`). Worker code can keep both ends of a pair in one
  realm (the celld-peer bridge, a Durable Object's 101 to a caller in the same runtime), where
  neither end pings; the package's `ServerWebSocket` starts its heartbeat watch in its constructor
  and would close such a socket with 1006 after 30 s. They also carry workerd's semantics: `send`
  before `accept`, close codes and `1005`, attachments, hibernation, `goAway`. Needed: a server end
  whose watch starts with the first ping, and a client end that is not a page's.
- **HTTP links over ports** (`src/transport/port.ts`). Over the package's `connectHttpLink` /
  `serveHttpLink`, each exchange whose response body is read to its end (a GET, a POST) leaves one
  multiplexed port open, and the link refuses calls after 1024 of them (`webrun-rpc: maxPorts
  (1024) reached`); one whose response has no body (a HEAD) or whose body is cancelled does not. cellb drains both sides of every exchange (`fetchClosing`,
  `servingClosing`, `p31-port-leak.test.ts`), which the package's links have no hook for. Needed:
  the same draining in the package.
- **The router** (`CellRouter`, `installProjectRouter`, `joinProjectShards`, `shardRouting`).
  - `SwHttpAdapter.start()` registers the ServiceWorker with no `type`: re-registering a module
    worker (the examples' are) as a classic one fails. Needed: a `type` option, or an adapter for a
    worker the page registered.
  - A handler's socket to another handler (`ws-open`) carries only a url and subprotocols. A
    Durable Object's socket into another shard needs its binding, target and shard. Needed:
    headers on `ws-open`, as on `ws-connect`.
  - The dispatcher routes by the first path segment under its scope and only urls inside it.
    cellb serves projects at `<basePath><name>/`, one at the origin's root (with a host page for
    navigations no tab serves), tunnels cookies, and sends calls between shards to
    `http://cellb.internal/`. Needed: a dispatcher whose `fetch` handling a host can take over (or
    a key function), and `dispatch()` for requests whose url is not under the scope.

## Consequences

- One copy of the package's code is bundled where cellb's WebSocket client is: about 20 KB
  minified, most of it the HTTP codec the package's bundle builds at load (a single file, so
  `sideEffects: false` cannot drop it).
- Once the package carries the rest, the router and links move, and `CellRouter`'s own
  bookkeeping (in-flight requests, owner liveness, drain, re-linking) goes with them.
