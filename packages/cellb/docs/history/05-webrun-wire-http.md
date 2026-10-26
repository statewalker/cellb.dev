# 05 — HTTP handlers on the webrun-wire packages

**Objective.** Replace P04's hand-rolled transport (buffered Request/Response
envelopes over `callPort`/`listenPort`) with the webrun-wire HTTP stack, so the
cell host is reachable over any webrun-wire transport with streaming bodies.

**What webrun-wire offers (repo at 770ff36, 2026-09-27; npm versions identical).**

| Package | Role here |
|---|---|
| `@statewalker/webrun-http-streams` 0.2.2 | `serveFetchOverDuplex(handler)` / `fetchOverDuplex(call, req)`: HTTP/1.1 on a `Duplex`, streaming bodies, abort via `request.signal` |
| `@statewalker/webrun-rpc` 0.4.0 | `serve` / `connect` + `overPipe(port, { codec: structuredCodec, side })`: port mux, one virtual port per call, window-of-one backpressure |
| `@statewalker/webrun-http-browser` 0.6.0 | `SwHttpAdapter` (page) + `sw-worker.js` (SW): same-origin ingress, unchanged from P04 |
| `@statewalker/webrun-streams` 0.2.0 | `serializeError` / `deserializeError` for errors crossing the link |
| `@statewalker/webrun-rpc-http` | evaluated, **not used** for DO RPC: methods take one JSON `params` object; CF RPC is positional args with structured-clone types |

Swapping `overPipe(port)` for `webrun-streams-ws`, `-webrtc`, `-libp2p` changes nothing
above the `Duplex` — the path for P05 forwarding to an owner tab or peer.

**Design.** Everything a remote caller does is HTTP, served by ONE handler,
`cellsHttpHandler(runtime)`:

- no control header → the Worker's own `fetch` (ingress);
- `x-webrun-cells: describe` → `{ bindings }` (namespace keys, so `idFromName` stays local);
- `x-webrun-cells: fetch` + binding + target → `stub.fetch(original request)`, body streamed;
- `x-webrun-cells: rpc` + method → args/result encoded with the `ValueCodec`;
- errors → `500` + `x-webrun-cells: error` + serialized error, re-thrown client-side.

`remoteRuntime(send)` is the client over any `send: (Request) ⇒ Response`;
`serveRuntime(port)` / `connectRuntime(port)` bind it to a port with webrun-rpc.

**Conclusions.**
- Bodies now stream end to end: a DO answering `text/event-stream` delivers its three
  chunks 30 ms apart over the port (Node) and to a page `fetch` through SW → page →
  worker (Chromium).
- The HTTP/1.1 wire keeps host, port and query but **drops the scheme** (documented in
  webrun-http-streams). The client sends it in `x-webrun-cells-proto`; the host rebuilds
  the URL, so the DO sees exactly `https://app.example:8443/a/whoami?q=1`.
- Control headers are stripped before a request reaches user code.
- The handler is usable with no transport at all (`remoteRuntime(cellsHttpHandler(rt))`),
  which makes the HTTP surface unit-testable without ports.
- `overPipe` wants a dedicated pipe: the browser page now transfers a `MessageChannel`
  port to the cell worker instead of using the `Worker` object itself.

**Trust model.** `cellsHttpHandler` belongs on internal links only (page ⇄ worker,
owner ⇄ forwarder). Public ingress (SW, node:http) must call `runtime.fetch`, otherwise
a client could address any object directly with control headers. The browser harness
still routes SW ingress through `remote.fetch` without control headers — fine, since
the host treats header-less requests as ingress; P05 should strip `x-webrun-cells*`
from incoming public requests explicitly.

**Verification.** 46 unit tests; mutation harness 11/11 killed (new: scheme not
restored, control headers leak, remote errors returned instead of thrown); browser
e2e 5/5 (new streaming spec).

**Code.** `src/transport/cells-http.ts`, `src/transport/port.ts`, `browser/main.ts`,
`browser/cell-worker.ts`; tests `test/p04-port-host.test.ts`, `browser/e2e/cells.spec.ts`.
