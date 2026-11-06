---
"@statewalker/cellb": patch
---

partyserver (cloudflare/partykit) runs on cellb unchanged, including Servers loaded at run time
through a Worker Loader and run as facets, on Node and in browsers:

- A WebSocket upgrade reaches a loaded Worker and its facets: it crosses into the isolate on a
  channel of its own (a fetch crosses as HTTP/1.1, which drops `Upgrade`), and the 101 answer's
  socket is relayed back. In a browser, a facet stub's `fetch` keeps `Upgrade` and
  `Sec-WebSocket-*`, which a copied `Request` drops.
- A loaded Worker's realm has the Workers globals (`WebSocketPair`, a `Response` that takes
  `{ status: 101, webSocket }`, `Request`, `WebSocket`) as free names, on Node and in browsers.
- `ctx.facets.get(name, () => ({ class, id }))` gives a facet of loaded code that `id` (its
  `ctx.id.name`, partyserver's `this.name`), as it already did for local classes.
- Frames a server sends before its 101 response is handed over (partyserver greets the socket in
  `onConnect`) are no longer dropped: `takeClientPort` hands them to the new holder first.
- Two facets of loaded code given the same `id` keep their own object and storage (the id is
  their `ctx.id` only).
- An upgrade's port into an isolate closes when the upgrade is refused or fails, and a socket's
  relay closes with its closing handshake; a 204/205/304 answer has no body; an error that
  cannot be copied crosses as its name and message.
- When a runtime closes, the sockets open into its loaded Workers close with 1001.
