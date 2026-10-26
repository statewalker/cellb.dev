# 19 — Projects served by an in-browser HTTP server; Worker Loader and facets on it

**Question.** Does webrun-cells work with an in-browser "HTTP server" —
`@statewalker/webrun-http-browser` (ServiceWorker adapter) with a
`@statewalker/webrun-site-builder` handler hosted by `@statewalker/webrun-site-host` — so
that Worker code is *compiled and served* by the browser itself and *executed* in a worker
by importing real URLs? Can the Worker Loader (and therefore facets) be built on it?

**Answer: yes.** All 25 projects (18 celld examples + 7 of ours, including the new
`facets-api`) run this way in Chromium and match the transcripts and logs recorded from
the real celld 0.6.2 (`browser/e2e/site-projects.spec.ts`).

## Architecture

```
page ── HostedSiteBuilder (webrun-site-host) ──► ServiceWorker (webrun-http-browser)
          handler = createProjectSite({ projectFiles })   (webrun-site-builder)
            GET  /modules/~/<path>         project sources → ESM (webrun-modules)
            PUT  /loaded-src/<id>/<file>   Worker Loader uploads loaded code
            GET  /loaded/<id>/~/<file>     loaded code → ESM (one module server per id)
            GET  /src/<path>               raw files

Dedicated Worker ── import("<site>/modules/~/index.js") ──► runtime (webrun-cells)
                    LOADER.get(id, code) → PUT /loaded-src/… → import("<site>/loaded/<id>/~/…")
```

- `src/project/site.ts`: `createProjectSite()`, `workersHostRegistry()` (what the `~deps`
  proxies read: `cloudflare:workers`, `Response`, `WebSocketPair`), `siteModuleLoader()`.
- No bundler and no Blob URLs: relative imports, `~deps` proxies and loaded code are all
  ordinary URLs answered by the page's handler through the ServiceWorker. Code is compiled
  on first request (webrun-modules caches the result).

## Worker Loader and Tail Workers over the server

`siteModuleLoader(baseUrl)` stores each module of a `WorkerCode` with `PUT`, then imports the
main module. webrun-modules 0.3 emits **one globals proxy per project root**, so each loaded
Worker gets **its own module server** (`/loaded/<id>/…`); its `console` global is bound to that
Worker's console, which feeds its Tail Workers. (A per-directory selection from
`import.meta.url` does not work: the proxy lives at the root `~deps/~globals.js`.)

## Facets

celld's `facets` example and our `facets-api` project — classes from the Worker Loader and
from `ctx.exports`, one database per facet name, `abort` and `delete`, RPC to a loaded
`WorkerEntrypoint`, `props` — match celld in Node, in Chromium with Node-side bundles, and in
Chromium over the in-browser server. Recording `facets-api` on celld corrected two things:

- **`facets.abort(name)`** stops the stubs handed out so far (their calls throw the reason);
  a later `facets.get(name)` restarts the facet **on the same database** (data kept).
  `facets.delete(name)` clears the database. Implemented with per-stub generations and
  `ObjectHost.restart()` (fresh instance, same SQLite).
- **`ctx.exports.<DurableObjectClass>`** is accepted as a facet `class`.

## Notes

- The Service Worker script is the one already used by the P04 demos (`/sw-worker.js` →
  vendored `webrun-http-browser` 0.6.5 runtime); webrun-site-host registers it.
- Name clash: `statewalker/webrun-sites` has its own `@statewalker/webrun-cells` package
  (an incremental SQLite engine, unrelated). This app should be renamed before publishing.
