# WebSockets over MessagePorts, Injected through webrun-modules ~deps

_Working document — 28 September 2026_

## 1. Problem

A ServiceWorker cannot intercept WebSocket connections, so `new WebSocket(url)` from a
page can never reach a Durable Object in a shard worker. On the DO side, Cloudflare code
uses `new WebSocketPair()` and `new Response(null, { status: 101, webSocket })`, and the
platform `Response` rejects status 101.

## 2. Decision (user)

Load user code through **webrun-modules** and override the free globals in its `~deps/`
layer — `WebSocket` for client code, plus `WebSocketPair` and `Response` for DO code —
with implementations on top of MessagePorts. The real `globalThis.WebSocket` stays
untouched.

## 3. How webrun-modules does it (0.2.1, verified by probe)

- Free variables on the `globals` allowlist are rewritten to an import from a co-located
  proxy: `./~deps/{module}/deps.globals.js`.
- A `globals` entry is a module expression; bound to the host registry the proxy is
  `const __g0 = globalThis.__webrunHostRegistry.get("WebSocket"); export { __g0 as WebSocket };`.
- `provided` also binds bare specifiers, e.g. `"cloudflare:workers" → { DurableObject }`.
- Without the `globals` entry, `WebSocket` stays a native reference (probe).

```ts
const registry = newHostRegistry({ "cloudflare:workers": { DurableObject }, WebSocketPair, Response: CellsResponse });
newModuleServer({ project, cache, provided: registry,
  globals: { WebSocket: `globalThis.__webrunHostRegistry.get("WebSocket")`, WebSocketPair: …, Response: … } });
registry.set("WebSocket", createWebSocketClass(connect));   // late binding is allowed
```

## 4. Implementation (`src/ws/`)

- **Wire:** frames on a MessagePort: `{ t: "m", d: string | ArrayBuffer }` and
  `{ t: "c", code, reason }` (close; echoed to complete the handshake).
- **`createWebSocketClass(connect)`:** WHATWG-compatible class (`readyState`, `protocol`,
  `binaryType` blob/arraybuffer, `send`, `close` with code/reason validation,
  `on*` and `addEventListener`, `CloseEvent`-compatible events). It is open when `connect`
  resolves with a port (after a 101); a refused upgrade gives `error` then `close 1006`.
- **`WebSocketPair` / `CfWebSocket`:** Cloudflare semantics: events only after `accept()`,
  `send`, `close`, `serializeAttachment`. The two ends are a MessageChannel.
- **`CellsResponse`:** extends `Response`, accepts `{ status: 101, webSocket }`.
- **`runtime.connectWebSocket(url, protocols)`:** runs the Worker's fetch with an Upgrade
  request; on 101 it detaches the client end's MessagePort (`takeClientPort`) and returns it
  — a transferable, so it can travel to another realm.

## 5. Verified (Node)

- Room DO: open, subprotocol negotiation, text echo, binary round trip, broadcast to two
  sockets, server-initiated close (4000, "bye bye", clean), client-initiated close, sends
  after close ignored, refused upgrade → error + 1006, browser-like API guards.
- **Unmodified sources built by webrun-modules:** a Cloudflare worker
  (`import { DurableObject } from "cloudflare:workers"`, `new WebSocketPair()`,
  `new Response(null, { status: 101, webSocket })`) and a browser-style client
  (`new WebSocket(url)`) are served with `~deps` proxies, imported, and talk to each other.
- Mutants killed: 101 status ignored; no close echo; no error event on refusal.

## 6. Browser routing design (not built yet)

The port must reach the page that opened the socket:

```
page (CellsWebSocket.connect) ──postMessage {ws, url, protocols, replyPort}──► ServiceWorker
ServiceWorker: CellRouter.ingress(Upgrade request) → shard worker runs the Worker fetch
shard worker: 101 → client-end port ──ctl channel──► ServiceWorker ──replyPort──► page
```

- The HTTP links (webrun-http-streams over webrun-rpc) cannot carry MessagePorts, so each
  shard needs a third, raw **control port** for port transfers (or webrun-rpc's port
  transfer support).
- DO → DO WebSockets across shards use the same control channel.
- Socket ports die with the owner's tab; the client sees `close 1006` via the owner-lock
  watch (doc 05).

## 7. Open threads

- Hibernation API on top of this (sockets owned by the runtime, not the instance).
- Backpressure: `bufferedAmount` is always 0.
- Whether to also patch `globalThis.WebSocket` in pages for code not loaded through
  webrun-modules.
