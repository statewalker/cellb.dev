---
"@statewalker/cellb": minor
---

The fragment host in a browser (#191): `joinFragmentShards` (`@statewalker/cellb/tabs` and `/browser`) runs one pool of shard workers shared by the origin's tabs, and `serveFragmentShard` is its worker side. Every worker holds every fragment (each in OPFS pools of its own), fragments are added and removed while it runs, and the ServiceWorker's router sends `<basePath>fragments/<id>/…` to the pool, then to the fragment DO at `idFromName(<id>)` in the shard that owns it. A project's own `cloudflare:workers` `waitUntil` now holds the scope it was loaded with, so several projects share one realm.
