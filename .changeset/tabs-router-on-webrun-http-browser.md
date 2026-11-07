---
"@statewalker/cellb": minor
---

The router of a project shared by tabs (`installProjectRouter` / `joinProjectShards` / `serveProjectShard`) now runs on webrun-http-browser's ServiceWorker dispatcher. The ServiceWorker no longer keeps a `CellRouter` per project. A tab attaches its shard workers with the package's adapter; a shard serves with `serveHttpInWorker` and reaches the other shards through `http://cellb.internal/<project>/`. Re-linking after a ServiceWorker restart, owner liveness, wake, keep-alive and drain on hand-over are the package's.

What cellb adds is unchanged:

- the project urls: `basePath`, a root project with `passthrough` and the host page, and `stripBase`;
- the page's cookies in and the Worker's `Set-Cookie` out;
- no `x-cellb*` control headers from pages, on fetches or sockets;
- calls between shards routed to the shard that owns the object, failing with `ShardOwnerLostError` when its owner is lost.

`installProjectRouter` returns `{ dispatcher }` instead of `{ routers }`. Nothing read `routers`.

A request to a project that no tab has ever served now goes to the network. Before, it waited for a shard for up to 15 s, then answered 503. A root project's host page still covers navigations no tab serves.

`CellRouter`, `createShardWorker` and `shardRouting` stay, for hosts other than a ServiceWorker (Node).

A root project under Vite's dev server needs Vite's own paths (`/@fs/`, `/@vite/`, `/node_modules/`…) in `passthrough`, because a controlled shard worker's module imports reach the ServiceWorker too. That was already the case.
