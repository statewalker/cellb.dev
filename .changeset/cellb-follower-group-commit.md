---
"@statewalker/cellb": patch
---

A cellb follower in celld's log tier keeps its place under load. celld evicts a follower whose appends stay slower than max(4 × its siblings', 25 ms) for 2 s ("gray follower evicted"), and its acknowledgements then fall back to the bucket. cellb's follower fsynced two files per append, a segment and `state.json`, one append at a time, so on a slow disk celld dropped it. As celld's follower does, the appends that arrive while a leader's last write is on its way to disk are now written together, as one segment file headed by the fragment's range: one file and one directory fsync per burst. `state.json` changes only with the epoch, a seal or a truncation without entries. Segments written by 0.12.0 still load.
