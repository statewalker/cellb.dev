---
"@statewalker/cellb": patch
---

Node: code loaded through a Worker Loader binding (`env.LOADER.get(…)`) now runs from the published
package. Its `cloudflare:workers` module pointed at `cloudflare-workers.ts`, which exists only in
the sources, so every loaded Worker failed to build with `Could not resolve "./cloudflare-workers.ts"`.
