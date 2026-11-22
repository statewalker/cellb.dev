---
"@statewalker/cellb": patch
---

`dispose()` of a loaded Worker ends its isolate (#206), as in workerd: the worker thread on Node, or the Dedicated Worker in a browser, is terminated at once, so a Worker that never yields stops too, and its calls in flight reject with `loaded Worker "<id>" was disposed`. Before, `dispose()` only dropped the id from the cache: every `env.LOADER.load()` left its thread running until the runtime closed, and a runaway Worker could not be stopped. A disposed `load()` handle now refuses later calls; after a `get(id)` handle is disposed, the next `get(id)` loads the code again, as before.
