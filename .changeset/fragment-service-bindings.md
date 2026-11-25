---
"@statewalker/cellb": minor
---

Service bindings between the projects of a fragment host (#192): `services` naming another fragment gives a working binding (`fetch` and JS RPC) whose call runs where the target's fragment DO is: in the runtime on the same shard, through the router across shards, and over HTTP (`<url>/fragments/{id}/`, `/peers/{peerId}/fragments/{id}/`) on another host by the route table (`createFragmentHost({ routes, remote, peerId })`, `joinFragmentShards({ routes, peers })`, `FragmentHost.serveLink`). Only structured-cloneable values and one stream per call cross, in every placement, and a function, stub or `Request` fails with a `DataCloneError` naming the call; a call while the target or the caller is not active fails at once with `ServiceUnavailableError`. `ProjectHost.services` / `LoadProjectOptions.services` take a `ServiceResolver` for other hosts.
