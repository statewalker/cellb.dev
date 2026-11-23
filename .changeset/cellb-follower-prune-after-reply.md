---
"@statewalker/cellb": patch
---

A cellb follower in celld's log tier answers an append without waiting for the files the bucket already holds to be deleted (#228). Nearly every append carries celld's truncation watermark; the follower listed its directory and deleted the segments below it before replying, and those deletes also took the threads of Node's pool that the next write needed. Under load the appends ran slow enough for celld to evict the follower ("gray follower") or to count an append as failed, and its acknowledgements fell back to the bucket. The deletes now run after the replies, one prune at a time per leader; the base they prune to is on disk first.
