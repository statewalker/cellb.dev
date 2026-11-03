# WebSockets

A Worker or a Durable Object accepts a WebSocket with `WebSocketPair` and a `101` response; a
Durable Object can accept it as hibernatable (`ctx.acceptWebSocket()`) and receive frames in
`webSocketMessage()`. Worker code can also open client sockets with `new WebSocket(url)`.

```jsonc
{
  "name": "wsecho",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "durable_objects": { "bindings": [{ "name": "W", "class_name": "W" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["W"] }]
}
```

```js
export class W {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[0];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }
  async webSocketMessage(ws, msg) {
    let count = (await this.state.storage.get("count")) ?? 0;
    count++;
    await this.state.storage.put("count", count);
    ws.send(JSON.stringify({ echo: msg, count }));
  }
}
export default {
  async fetch(request, env) {
    return env.W.get(env.W.idFromName("w")).fetch(request);
  },
};
```

This is celld's `wsecho` example ([conformance/celld-examples/wsecho](../../conformance/celld-examples/wsecho/index.js)), copied
unchanged and run by the conformance suite on Node and in Chromium.

## In a browser, a WebSocket is a MessagePort

A ServiceWorker cannot intercept WebSockets, so in a browser pages and objects get a `WebSocket`
class whose frames travel over MessagePorts ([ADR 0006](../adr/0006-websockets-over-messageports.md)).
The `WebSocket` global of Worker code is workerd's, built over the host's: its prototype carries
`serializeAttachment` and `deserializeAttachment`, which partyserver and the Agents SDK use.

## Where CellB matches workerd or celld

- Either end of a `WebSocketPair` may `send()` before `accept()` (celld queues the frame; workerd
  refuses).
- `WebSocketPair` ends start with `binaryType` `"blob"` when the project sets
  `websocket_standard_binary_type`, `"arraybuffer"` otherwise. `webSocketMessage()` of a
  hibernatable socket always receives an `ArrayBuffer`.
- workerd's `wd-websocket-hibernation` test passes on CellB; celld fails it.

## How it is checked

celld's `wsecho` and `wsclient` examples, CellB's `ws-details` project and workerd's WebSocket
tests (`wd-websocket-*`), on Node and in Chromium.

## What breaks

- **A class that extends the `WebSocket` global gets a host socket**, not an instance of itself:
  `new WebSocket(url)` returns the host's own client socket.
- **A request whose `Upgrade` header vanished** is answered as a plain request (typically
  `426 Upgrade Required`): a link that rebuilds requests must carry `Upgrade` across
  ([architecture.md](../architecture.md#what-breaks)).
- Node's `WebSocket` takes `'BLOB'` as `'blob'`, and Chromium's `CloseEvent` keeps lone
  surrogates in a close reason (the `wd-websocket-constructor-gaps` known gap).
