# KV

`env.<BINDING>` of a `kv_namespaces` entry: `get`, `put`, `delete` and the rest of Workers KV. CellB
runs celld's own KV code (`services/kv.js`, vendored unchanged), so values, limits and error
messages are celld's, and a namespace's data moves between celld and CellB with its cell.

```jsonc
{
  "name": "kv",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "kv_namespaces": [
    {
      "binding": "VALUES",
      "id": "example-values"
    }
  ]
}
```

```js
export default {
  async fetch(request, env) {
    const key = new URL(request.url).pathname.slice(1);
    if (!key) return new Response("Use /KEY.", { status: 400 });

    if (request.method === "PUT") {
      await env.VALUES.put(key, request.body);
      return new Response(null, { status: 204 });
    }

    if (request.method === "DELETE") {
      await env.VALUES.delete(key);
      return new Response(null, { status: 204 });
    }

    const value = await env.VALUES.get(key);
    return value === null
      ? new Response("Not found.", { status: 404 })
      : new Response(value);
  },
};
```

This is celld's `kv` example ([conformance/celld-examples/kv](../../conformance/celld-examples/kv/index.js)), copied unchanged
and run by the conformance suite on Node and in Chromium.

## A namespace is a cell

A namespace lives in a cell `__KvNamespace:<id>`. Its key does not depend on the script, so every
project in a fleet that names the same namespace id reads the same data, as on celld. Values above
1 MiB are kept outside the cell, in a FilesApi (celld: the fleet bucket), through celld's own
prepare / put / get / sweep protocol. The limits are celld's (`celld_logic::kv`'s constants).

## How it is checked

celld's `kv` example and CellB's `kv-values` and `kv-details` projects, on Node and in Chromium;
`e2e/p11f-celld-one-bucket.test.ts` moves a namespace's data celld → CellB → celld through one
bucket.

## What breaks

Errors carry celld's messages: `KV_ERROR: …`.
