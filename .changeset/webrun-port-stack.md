---
"@statewalker/cellb": patch
---

cellb now depends on webrun-rpc 0.11, webrun-streams 0.3, webrun-http-streams 0.5 and webrun-http-browser 0.13. cellb's API and its messages on the wire are unchanged.

- **HTTP over a port, through webrun-http-streams:** a response body that is idle when its exchange is torn down is cancelled at once, with the abort's reason. Examples are an SSE stream between events or a long poll. Before, it was cancelled only when its next chunk arrived. A handler waiting on its request body fails at once, and an upload is cancelled as soon as its request's signal aborts.
- **Windowed HTTP links:** from a link's second exchange on, a request's body goes out before the peer's ack instead of waiting a round trip for it (webrun-rpc's `presumeAck`). The isolate links have no window and are unaffected.
- **Ports closed before a stream starts:** a stream on such a port now fails at once instead of waiting.
