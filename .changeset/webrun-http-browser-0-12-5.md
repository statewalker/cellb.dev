---
"@statewalker/cellb": patch
---

`hostSitesForWorker` and `siteCompiler`'s default host work on pages served over https. A request reaches the page's handler through webrun-http-browser, which before 0.12.5 rebuilt its url as `http://<host>/…`. The site's handler is registered under the page's own URL (`https://<host>/…/`), so on an https page no request reached it: every one answered "404 Error 404: Not found" (over http nothing showed). cellb is now on `@statewalker/webrun-http-browser` ^0.12.5, which rebuilds the url at the page's scheme, and `HostedSiteBuilder`'s page side (`SwHttpAdapter`) now comes from cellb's own webrun-http-browser. Before, it came from the ^0.7 copy that webrun-site-host depends on. cellb's copy is the version whose ServiceWorker hosts serve, and the one with the fix.
