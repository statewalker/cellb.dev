---
"@statewalker/cellb": patch
---

The HTTP links between a page, its shard workers and the ServiceWorker (`serveRuntime`, `connectRuntime`, `linkOverPort`, `serveHandlerOverPort`) are `@statewalker/webrun-http-browser`'s (`connectHttpLink` / `serveHttpLink`, 0.7.1), which give every exchange's multiplexed port back however it ends; cellb's own draining around them (`fetchClosing`, `servingClosing`) goes. With them come: a handler that answers first and reads the upload afterwards gets all of it, an aborted request to a handler that never answers gives its port back at once, and a request in flight when a link is closed fails instead of hanging. Requires webrun-http-browser 0.7.1, webrun-http-streams 0.3.1 and webrun-rpc 0.5.1.
