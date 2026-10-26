---
status: accepted
---

# One isolate, a realm of its own, per loaded Worker

celld runs each Worker Loader Worker in its own V8 isolate: loaded code does not see its parent's
globals or environment, and its env is exactly what its `WorkerCode` declares. cellb gives each
loaded Worker a realm of its own instead: a worker thread on Node, a Dedicated Worker in a browser,
behind one MessagePort. Durable Object classes of loaded code (facets) run inside that realm with
their own SQLite.

## Considered options

- **The parent's realm.** Rejected: the `isolation-api` project showed loaded code reading the host's
  globals and env and leaking its own writes back, unlike celld.
- **ShadowRealm.** Not available in the target platforms.
- **An iframe.** Browser-only, and it isolates nothing more than a Dedicated Worker for this purpose.

## Consequences

- Calls into a loaded Worker cross a structured-clone boundary: only `env` entries can be stubs; a
  function or stub as an argument, result or `props` value is refused.
- Each loaded Worker costs a thread or a worker. An idle isolate does not keep a Node process alive.
- An uncaught exception in an isolate is logged and the isolate keeps running, as in a Dedicated
  Worker and workerd.
- The project's own Worker is not isolated; it shares the host's realm.
