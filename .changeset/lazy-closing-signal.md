---
"@statewalker/cellb": patch
---

A request no longer gets copied so that its signal also aborts when the runtime closes. Since 0.2.0 every request to `runtime.fetch` and to a Durable Object's `fetch` was copied with a merged signal (`new Request(req, { signal: AbortSignal.any([...]) })`), about 7 µs each, which halved in-process throughput (about 80,000 → 40,000 requests a second on Node). The request is now handed over as it is, and its `signal` is a getter that merges the two signals the first time it is read: a long poll or an SSE stream that waits on it still ends when the runtime closes, and a handler that never reads it pays nothing. One difference: a copy the handler makes itself (`new Request(req)`, or `fetch(req)` to forward it) takes the request's own signal, without the runtime's.
