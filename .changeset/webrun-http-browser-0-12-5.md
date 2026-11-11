---
"@statewalker/cellb": patch
---

On `@statewalker/webrun-http-browser` ^0.12.5, which rebuilds a request's url at the scheme of the page that answers it. The workaround added for https pages (an adapter that gave each request the page's scheme back before the handler lookup) is gone: `hostSitesForWorker` and `siteCompiler`'s default host use `HostedSiteBuilder` as it is again.
