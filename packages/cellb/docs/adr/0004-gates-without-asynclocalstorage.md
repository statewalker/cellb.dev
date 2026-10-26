---
status: accepted
---

# Input and output gates without AsyncLocalStorage

Durable Objects need an input gate (no new event while a storage operation is in progress) and an
output gate (no reply before its writes are durable). Miniflare 2 finds the current gate through
`AsyncLocalStorage`. cellb does not: each object host owns its gate, its storage holds the gate by
closure, and events start from a queue that a synchronous pump runs only while the gate is open. The
output gate is a barrier over the storage's `committed()` promises.

## Considered options

- **`AsyncLocalStorage`.** Rejected: browsers do not have it, and the same core must run there.
- **`AsyncContext`.** Not available in the target browsers or Node.
- **Checking the gate when an event resumes.** Rejected after a failing test: 50 concurrent events
  all saw the gate open in their `await` continuations and all read `n = 0`.

## Consequences

- The gate releases on a macrotask, so the continuation of the operation that held it runs first; a
  microtask release breaks read-modify-write.
- Completions of non-storage I/O (timers, `fetch`) are not held by the input gate. celld behaves the
  same; workerd holds them.
