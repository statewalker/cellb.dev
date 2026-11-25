---
"@statewalker/cellb": minor
---

Fragment states and the host's own peer path (statewalker-root#259): `FragmentHost.disable`/`enable`/`state` on Node and `joinFragmentShards`' `disable`/`enable`/`state` in browsers keep a fragment known while it is stopped. A disabled fragment answers 503 and an unknown one 404 without waking a DO; in a browser the ServiceWorker's router answers both itself, from the fragment table the tabs tell it. `/peers/{peerId}/fragments/{id}/…` with the host's own `peerId` (`createFragmentHost({ peerId })`, `joinFragmentShards({ peerId })`) answers as `/fragments/{id}/…`.
