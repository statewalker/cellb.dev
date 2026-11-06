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
