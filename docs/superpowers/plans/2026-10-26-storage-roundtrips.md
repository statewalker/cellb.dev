# F6 — storage round trips for Workflows and R2 (plan)

Branch `feat/storage-roundtrips`. Restructure plan §8 F6: celld → cellb → celld through one fleet
bucket, as `packages/cellb/e2e/p11f-celld-one-bucket.test.ts` does for KV, D1 and Queues.

## What is already there, and what is missing

- R2: p11f moves single-`put` objects (bytes, HTTP and custom metadata, md5, ranges, listing)
  celld → cellb → celld. Multipart is not covered.
- Workflows: p11f moves instances celld → cellb and cellb → celld as **separate** instances. No one
  instance crosses twice.

## What celld allows (probed with celld 0.6.3 `dev`)

- A workflow instance is a cell (`__Workflow.<script>:<id>`), so all of it moves with the cell.
- An open R2 multipart upload lives in the memory of the celld node that created it: resuming it
  after a restart answers `R2 multipart upload 1 is not open on this node: celld can resume an
  upload within the node that created it, not across nodes or restarts`. Nothing of it is in the
  bucket. So the strongest R2 property is a **completed** multipart object crossing both ways; an
  open upload crossing runtimes is not a celld property and is out of scope (documented, not
  tested).
- celld's completed multipart object has no md5 in its `celld-r2` record (as on Cloudflare).

## Tasks

1. **Workflows: one instance, three runtimes.** `conformance/projects/workflow-api/index.js` gets
   a kind `relay`: step `a` → `sleep` 2 s → step `b` → `waitForEvent("go")` → step `c`, each step
   returning `navigator.userAgent` (celld: `Cloudflare-Workers`; cellb on Node: `Node.js/…`).
   p11f test: create on celld (a runs), stop during the sleep; cellb wakes it (b runs, then it
   waits); celld sends the event (c runs) and reports
   `{ a: celld, b: cellb, c: celld }`, `complete`. A step run twice would carry the other
   runtime's tag, so the output proves memoization across both hand-overs.
   Run: `pnpm vitest run e2e/p11f-celld-one-bucket.test.ts -t "one instance"`.
2. **R2: multipart objects both ways.** `conformance/projects/r2-handoff/index.js` gets
   `/mp?key=&who=` (create → two parts, 5 MiB + tail → complete, with metadata). The existing R2
   round trip in p11f gains steps: celld writes `m/one` by multipart; cellb reads it (size, tail,
   metadata) and writes `m/two` by multipart; celld reads `m/two`. `/get` already reports these.
   Run: `pnpm vitest run e2e/p11f-celld-one-bucket.test.ts -t "R2"`.
3. **Docs.** `docs/celld-compatibility.md`: the R2 row says where multipart uploads live on each
   side (celld: node memory; cellb: `r2-uploads/` in the bucket) and that an open upload does not
   cross. `docs/gaps.md`: drop the F6 item (or turn a failure into a gap with a `it.fails` test).
   Tick F6 in the restructure plan §8.

Any failing round trip: a fix in cellb if small and clear (TDD), else a gap in `docs/gaps.md` with
the symptom and an `it.fails` test.

## Bar

`pnpm test` (celld env) 354 + new steps passed / 7 expected fail / 1 skipped; `pnpm e2e` 181/14;
`pnpm mutate:check`, `pnpm -r typecheck`, `pnpm biome check .` exit 0.
