---
"@statewalker/cellb": minor
---

`createFragmentHost` (`@statewalker/cellb/node`): many wrangler projects side by side in one runtime, each in a namespace of its own (`<data>/fragments/<id>/`), added and removed while it runs, each reached at `/fragments/{id}/…` through its fragment DO at `idFromName(<id>)`, with unsupported configuration reported per project (#191). A single-project host's data layout is unchanged.
