---
"@statewalker/cellb": patch
---

On `@statewalker/webrun-http-browser` ^0.12.5, which rebuilds a request's url at the scheme of the page that answers it. `hostSitesForWorker` and `siteCompiler`'s default host now build `HostedSiteBuilder`'s page side (`SwHttpAdapter`) from cellb's own webrun-http-browser instead of the ^0.7 one webrun-site-host depends on: the version whose ServiceWorker hosts serve, and the one with the fix. The workaround added for https pages (an adapter that rewrote each request's scheme before the handler lookup) is gone.
