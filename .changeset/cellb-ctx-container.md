---
"@statewalker/cellb": minor
---

`ctx.container`: objects of a `containers` class get Cloudflare's container API when the host gives the runtime a container engine (`loadProject(…, { containers })`, `ProjectHost.containers`, `createCellRuntime({ containers })`) and the class has an image under the new `cellb.containers` key of its wrangler config (file references are read when loading and by `cellb build`). One container per cell, kept across the object's instances, destroyed after its inactivity timeout or by `close()`. The engine port and `createContainer` are exported from `@statewalker/cellb/container`. Without an engine or an image, the class is still reported in `unsupported`, now saying which is missing.
