---
status: accepted
---

# `idFromName` is synchronous

On Cloudflare and celld, `namespace.idFromName(name)` returns an id at once, and Worker code relies on
it. The ids are SHA-256 and HMAC over the namespace key and the name. WebCrypto's `crypto.subtle` is
asynchronous only, so cellb computes them with `@noble/hashes`, synchronously, on every platform.

## Considered options

- **`crypto.subtle`.** Rejected: it would make `idFromName` return a promise, which breaks code
  written for Workers.
- **Node's `crypto.createHash`.** Not available in browsers.

## Consequences

- `@noble/hashes` is a runtime dependency.
- The ids are byte-identical to celld's, which is what lets a cell keep its storage keys across the
  two runtimes.
