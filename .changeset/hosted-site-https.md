---
"@statewalker/cellb": patch
---

`hostSitesForWorker` and `siteCompiler`'s default host work on pages served over https. webrun-http-browser hands the page each request rebuilt as `http://<host>/…`, while the site's handler is registered under the page's own URL (`https://<host>/…/`), so no request reached it there: every one answered "404 Error 404: Not found" (over http nothing showed). The hosted site's adapter now gives a request of the page's host the page's scheme back before the handler is looked up.
