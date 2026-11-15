---
"@statewalker/cellb": patch
---

`installProjectRouter(self)` typechecks with TypeScript's WebWorker lib: `ServiceWorkerScope.addEventListener` takes a listener of `Event` instead of `never`, which a real `ServiceWorkerGlobalScope` was not assignable to.
