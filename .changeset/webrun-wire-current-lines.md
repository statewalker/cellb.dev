---
"@statewalker/cellb": minor
---

Moves to webrun-wire's current lines (statewalker/statewalker-root#69): `@statewalker/webrun-rpc`
^0.11.0 -> ^0.15.0, `@statewalker/webrun-streams` ^0.3.0 -> ^0.6.0,
`@statewalker/webrun-http-streams` ^0.5.0 -> ^0.8.0 and `@statewalker/webrun-http-browser`
^0.13.0 -> ^0.17.0; the optional peer `@statewalker/webrun-site-host` ^0.4.0 -> ^0.6.0. These are
breaking lines: webrun-rpc's port wire changed across them, so a page hosting sites with cellb
must serve the ServiceWorker script (`/sw-worker.js`) from `@statewalker/webrun-http-browser`
0.17 too. No API change in cellb. An error a loaded Worker's `fetch` throws in its isolate still
reaches the caller with the stack where it was thrown (webrun-http-streams 0.6 leaves it out of
its error header unless asked).
