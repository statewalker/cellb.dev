---
status: accepted
---

# celld's storage format is cellb's only format

A cell must be able to move between celld and cellb through one bucket, in both directions. So cellb
stores a cell exactly as celld does: celld's object ids, celld's internal tables (`_cf_KV`,
`_cf_ALARM`, `_cf_METADATA`, `_cf_FACETS`, `_cf_WAKE`), values in V8 serialization, and logs as
LTX v3 files in celld's bucket keys. There is no cellb-specific schema or value codec to fall back
to.

## Considered options

- **An own schema and a tagged-JSON value codec, with an export to celld's format.** Rejected: every
  hand-over would need a conversion that both sides must agree on, and a converted cell is no longer
  byte-identical, so restore bugs hide in the converter.
- **SQLite changesets as the log.** They are available in both drivers without page capture, and
  `filesApiChangeLog` still offers them, but celld cannot read them. They stay an option for a
  runtime that never shares a bucket with celld, not the default.

## Consequences

- Browsers have no `v8.serialize`, so cellb carries a V8 serializer in TypeScript (`src/v8/`), which
  must stay byte-identical to V8's for the types Workers store.
- Logging LTX needs each commit's changed pages: a hook on SQLite WASM's database file, a WAL read
  or an image diff on node:sqlite.
- celld's quirks in its format (no rolling checksums, the `NO_CHECKSUM` flag, WAL-mode images) are
  cellb's quirks too.
- cellb keeps one table of its own, `_cf_LOG`, for the changeset log's sequence; celld ignores it.
