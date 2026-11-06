# Durable Objects

A Durable Object class is a project's stateful code; each object is a **cell**: one SQLite
database, owned, logged and moved as a unit ([CONTEXT.md](../../CONTEXT.md)). CellB stores a cell
exactly as celld does, so the same object can be served by celld, then by CellB in Node, then by a
browser, and back ([celld-compatibility.md](../celld-compatibility.md#the-same-cell-is-stored-the-same-way)).

```jsonc
{
  "name": "counter",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

```js
export class Counter {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    let n = (await this.state.storage.get("n")) ?? 0;
    n++;
    await this.state.storage.put("n", n);
    return Response.json({ n, url: request.url });
  }
}
export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(request);
  },
};
```

This is celld's `counter` example ([conformance/celld-examples/counter](../../conformance/celld-examples/counter/index.js)),
copied unchanged and run by the conformance suite on Node and in Chromium.

## A cell is stored as celld stores it

- **Ids** are derived from the script name and class as celld derives them, synchronously
  ([ADR 0008](https://github.com/statewalker/cellb.dev/blob/922612ee1856b64e31d3b1d4f1d09e2c51261781/packages/cellb/docs/adr/0008-synchronous-idfromname.md)).
- **Storage** is celld's internal tables (`_cf_KV`, `_cf_ALARM`, `_cf_METADATA`, …), plus CellB's own `_cf_LOG`, in the object's
  SQLite, values in V8 serialization version 15, written by a TypeScript serializer in browsers.
- **Logs** are LTX v3, as celld writes them, so a cell CellB wrote is one celld can continue.

## Every platform keeps Cloudflare's guarantees inside a cell

The first SQL statement opens a transaction that commits when the event loop turn ends; an input
gate keeps other events out while a handler's storage operations run; an output gate holds a reply
until the commit it depends on is durable. These hold in Node and in browsers, with every storage
([ownership-and-durability.md](../ownership-and-durability.md)).

`ctx.storage.sql.exec()` is synchronous and returns rows at once, as on Cloudflare: both SQLite
drivers (`node:sqlite`, SQLite WASM on OPFS) are synchronous underneath. Alarms are kept in the
cell (`_cf_ALARM`) and published in celld's wake index on a fleet bucket.

## Who owns a cell depends on where it runs

| Deployment | Owner |
|---|---|
| One process | the process |
| A browser origin | the shard worker holding the shard's Web Lock |
| A fleet bucket shared with celld | celld's ownership record (`own.json`) per cell |

## Where CellB differs from celld

- **Names starting with `_cf_` are refused more strictly**: a column `_cf_col`, a literal `'_cf_x'`,
  `ALTER TABLE … RENAME TO _cf_t2`. An object that keeps out of `_cf_` names sees no difference.
- **`ctx.exports.X({ props })` stubs and class handles can be stored**, as on workerd. celld refuses
  them and cannot read them back.
- **A timer set before `blockConcurrencyWhile()` fires while its callback runs**, as on celld;
  workerd holds it.

## How it is checked

celld's `counter`, `rpc` and `alarm` examples and workerd's own Durable Object tests, on Node and in
Chromium; `e2e/p11f-celld-one-bucket.test.ts` moves cells celld → CellB → celld through one bucket.

## What breaks

- **Renaming the project's `name` makes every object start empty.** Ids derive from the script
  name; the old cells stay in storage under their old keys.
- **`OwnershipRecordLostError`**: the cell's ownership record was lost on a fleet bucket
  ([ownership-and-durability.md](../ownership-and-durability.md#what-breaks)).
- **`BrokenObjectError` ("Durable Object reset because …")**: a commit did not become durable, a
  constructor's `blockConcurrencyWhile()` rejected, or the lease was lost. The next call builds a
  fresh instance.
