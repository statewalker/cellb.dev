---
"@statewalker/cellb": patch
---

"Remove with data" reaches every tab's shards (statewalker/cellb.dev#252). `joinFragmentShards`' `remove(id, { withData: true })` deleted the fragment's data only in the shards the calling tab runs. Now it leaves a marker per shard in the origin's OPFS (`.cellb-fragment-removals`) and tells the other tabs on a BroadcastChannel; they remove the fragment and its data in the shards they run. A shard that starts later (another tab, a reload) deletes the data before it serves the fragment again, at its start and before loading it. `remove` waits up to `removeWaitMs` (10 s, new option) for the other shards to clear their markers.
