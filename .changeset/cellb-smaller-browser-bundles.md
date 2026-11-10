---
"@statewalker/cellb": minor
---

Smaller browser bundles. A page that joins a project shared by the tabs and its ServiceWorker
import `joinProjectShards` and `installProjectRouter` from the new `@statewalker/cellb/tabs`
entry, which holds only the routing code (about 75 KB minified instead of about 280 KB). In a
shard, the binding implementations a project declares load on demand: `loadProjectBindings(config)`
imports Miniflare's D1 simulator, celld's KV, queue and workflow code, R2, assets, cron and Worker
Loaders only for the bindings `wrangler.json` names, and the HTMLRewriter glue loads on first use.
The counter demo's shard worker goes from 759 KB to 488 KB, 214 KB of which is SQLite's own JS.

`createProjectRuntime(config, module, host)` now takes these implementations in
`host.bindings` (`bindings: await loadProjectBindings(config)`); a config that declares a binding
the host did not load is refused with an error saying so. `loadProject`, `browserProjectRuntime`
and the Node hosts load them themselves.
