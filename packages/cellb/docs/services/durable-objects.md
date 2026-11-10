# Durable Objects

A Durable Object class is a project's stateful code. Each object is a **cell**, a single SQLite
database that is owned, logged and moved as a unit ([Glossary](../../CONTEXT.md)). CellB stores a cell
exactly as celld does, so the same object can be served by celld, then by CellB in Node, then by a
browser, and back ([celld
compatibility](../celld-compatibility.md#the-same-cell-is-stored-the-same-way)).

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

- **Ids** are derived from the script name and class as celld derives them, synchronously.
- **Storage** uses celld's internal tables (`_cf_KV`, `_cf_ALARM`, `_cf_METADATA`, …) plus CellB's
  own `_cf_LOG`, in the object's SQLite. Values are in V8 serialization format version 15; in
  browsers a TypeScript serializer writes them.
- **Logs** are LTX v3, as celld writes them, so a cell CellB wrote is one celld can continue.

## Every platform keeps Cloudflare's guarantees inside a cell

The first SQL statement opens a transaction that commits when the current turn of the event loop
ends. An input gate keeps other events out while a handler's storage operations run, and an output
gate holds back a reply until the commit it depends on is durable. These guarantees hold in Node
and in browsers, with every kind of storage ([Ownership & durability](../ownership-and-durability.md)).

`ctx.storage.sql.exec()` is synchronous and returns rows at once, as on Cloudflare, because both
SQLite drivers (`node:sqlite`, and SQLite WASM on OPFS) are synchronous underneath. Alarms are kept
in the cell (`_cf_ALARM`) and published in celld's wake index on a fleet bucket.

## Who owns a cell depends on where it runs

| Deployment | Owner |
|---|---|
| One process | the process |
| A browser origin | the shard worker holding the shard's Web Lock |
| A fleet bucket shared with celld | celld's ownership record (`own.json`) per cell |

## Where CellB differs from celld or workerd

- **Names starting with `_cf_` are refused more strictly**, for example a column `_cf_col` or
  `ALTER TABLE … RENAME TO _cf_t2`. A `_cf_` name inside a string literal or a comment is allowed.
  An object that avoids `_cf_` names sees no difference.
- **`ctx.exports.X({ props })` stubs and class handles can be stored**, as on workerd. celld refuses
  to store them and cannot read them back.
- **A timer set before `blockConcurrencyWhile()` fires while its callback runs**, as on celld;
  workerd holds it.

## How it is checked

celld's `counter`, `rpc` and `alarm` examples and workerd's own Durable Object tests, on Node and in
Chromium. `e2e/p11f-celld-one-bucket.test.ts` moves cells from celld to CellB and back through one
bucket.

## What breaks

- **Renaming the project's `name` makes every object start empty.** Ids derive from the script
  name; the old cells stay in storage under their old keys.
- **`OwnershipRecordLostError`** means the cell's ownership record was lost on a fleet bucket
  ([Ownership & durability](../ownership-and-durability.md#what-breaks)).
- **`BrokenObjectError` ("Durable Object reset because …")** means a commit did not become durable,
  a constructor's `blockConcurrencyWhile()` rejected, or the lease was lost. The next call builds a
  fresh instance.
