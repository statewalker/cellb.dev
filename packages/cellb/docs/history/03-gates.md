# 03 — P03 input and output gates

**Objectives.** Reproduce DO concurrency semantics without Node's AsyncLocalStorage:
read-modify-write safety over storage awaits, `blockConcurrencyWhile`, responses held
until writes are durable, write coalescing, and reset of an object whose commit failed.

**Conclusions.**
- Miniflare 2 finds the "current gate" via AsyncLocalStorage. Here each object owns its
  gate and its storage captures it by closure — no ALS needed, works in any JS runtime.
- **Red found a real bug**: checking the gate in an `await` continuation is too late —
  50 concurrent events all saw it open and all read `n = 0`. Fix: a per-object event
  queue with a *synchronous pump* that starts an event only while the gate is open; the
  handler's first storage op closes the gate before the pump loops.
- Gate release is deferred to a macrotask (`setTimeout 0`) so the continuation of the
  op that held it runs first; waiters are woken one at a time. Releasing on a microtask
  breaks the counter test (mutant killed).
- Output gate = barrier over durability promises from `CellDurability.committed()`.
  Read-only events are not delayed; one event's 100 sync writes → exactly one commit.
- A failed durable commit marks the object broken: the caller gets `BrokenObjectError`
  and the next call constructs a fresh instance.
- As on CF, the gate does not protect across non-storage I/O (test documents lost updates).

**Lessons / open.**
- Completions of non-storage I/O (fetch, timers) are not held while the gate is closed —
  would need ALS/AsyncContext or wrapping `fetch` per object. Acceptable for now.
- After a durability failure the local SQLite still holds the commit; P06 must decide
  whether to roll back to the last durable snapshot on reset.
- Timing-based assertions (sleep 20–50 ms) passed 5/5 runs; P07 should introduce an
  injectable clock.

**Code.** `src/core/gates.ts`, `src/core/object-host.ts` (`deliver`, `#pump`, `#barrier`);
tests `test/p03-gates.test.ts`; mutation harness `scripts/mutate.mjs`.
