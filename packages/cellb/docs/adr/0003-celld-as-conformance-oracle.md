---
status: accepted
---

# celld is the conformance oracle

Every behaviour cellb shares with celld is recorded from the real celld (`conformance/golden/`) and
cellb must answer the same, in Node and in Chromium. workerd is recorded too
(`conformance/golden-workerd/`), but only to pin where celld differs from it (`workerdDiffers`).

celld is the target because cellb shares its storage and its fleet: a cell must behave the same
whichever runtime serves it next. workerd's tests are still run, unchanged, and judged against
celld's answers.

## Considered options

- **workerd (or Miniflare) as the oracle.** Rejected: it would make cellb disagree with celld on
  exactly the cells that move between the two, for example stub cloning and error wording.
- **Expectations written by hand.** Kept only for what celld cannot show (shards, Web Locks, the
  browser's WebSocket routing), and checked by mutation harnesses.

## Consequences

- cellb reproduces celld's deviations from Cloudflare, including its refusals. Known celld bugs
  (nested `index.html` in assets) are the exception: cellb follows Cloudflare and the comparison omits
  those requests.
- Exception (D10): stubs, functions and `RpcTarget`s pass by reference as on workerd, so the
  scenarios marked `judge: "workerd"` are judged against the workerd goldens
  ([conformance.md](../conformance.md#where-cellb-follows-workerd-instead)).
- Goldens are tied to a celld version; a celld upgrade re-records all of them.
