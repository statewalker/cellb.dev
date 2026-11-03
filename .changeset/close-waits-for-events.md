---
"@statewalker/cellb": patch
---

`runtime.close()` shuts down in order instead of closing the databases under running code: it aborts the signal of the requests in flight (the Worker's and its Durable Objects', as when a client goes away on Cloudflare, so long polls and SSE streams end), lets events still running and `waitUntil` work finish within `closeGraceMs` (default 2 s), including the calls they make to other objects (a queue's delivery to its consumer, say), then takes the final backups and closes. A closed runtime answers requests with 503 and opens no cell again (it reopened them on storage that was closed or already another runtime's); an object's code still running fails with `ObjectClosedError` instead of SQLite's "DB has been closed".
