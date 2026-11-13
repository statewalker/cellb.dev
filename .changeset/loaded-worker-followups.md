---
"@statewalker/cellb": patch
---

Follow-ups to the Worker Loader changes of 0.8.9:

- In a browser isolate, an `import()` in code the loaded Worker builds with `Function` (or `AsyncFunction` and the generator constructors) resolves against its modules, as on Node and workerd: the isolate's function constructors route it. Kitesurf imports page modules this way; before, such an `import()` resolved against the isolate worker's URL.
- A `Response.error()` returned across an isolate arrives as an error response (status 0) instead of failing the call; a response with a status the `Response` constructor refuses arrives without a body, still reporting its status.
- Loading code finds a module's import() calls and its export names in one parse instead of two (a CommonJS module still has its own scan).
