---
status: accepted
---

# KV, Queues and Workflows run celld's own JavaScript

celld implements its KV namespaces, Queues and Workflows in JavaScript (`services/kv.js` and parts of
`harness.js`), written to run on more than one engine. cellb runs that code unchanged as a third
host: `scripts/vendor-celld.mjs` copies it into `vendor/celld/` (Apache-2.0), and
`src/bindings/celld-*.ts` supplies what celld's engine would. Where that JavaScript asks celld's Rust
for a decision (the seven policy operations of `celld_logic::queue`), the decision is ported to
TypeScript.

## Considered options

- **Miniflare's simulators.** Rejected for these three: celld's KV differs from Miniflare's in
  error messages, limits and listing, and Miniflare stores nothing in celld's layout. Miniflare's D1
  simulator is still used, because celld's D1 cell has the same layout.
- **Own implementations.** cellb had its own queue and workflow cells; they matched recorded
  transcripts but not celld's storage, so pending messages and sleeping instances could not move.
  They were removed.

## Consequences

- A queue, workflow instance or KV namespace written by celld continues on cellb, and back.
- Upgrading celld means re-vendoring, and re-checking the ported Rust policies by hand: the vendored
  JavaScript is checked by the conformance corpus, the ports only by the queue projects.
