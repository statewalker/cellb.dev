---
"@statewalker/cellb": patch
---

Node: code loaded through a Worker Loader binding (`env.LOADER.get(…)`) now runs from the published
package. Its `cloudflare:workers` module pointed at `cloudflare-workers.ts`, which exists only in
the sources, so every loaded Worker failed to build with `Could not resolve "./cloudflare-workers.ts"`.

A project runtime's `close()` now ends the isolates of its loaded Workers (a worker thread on Node,
a Dedicated Worker in a browser). On Node, an isolate's port kept the process alive after `close()`.
