# KV

Each `kv_namespaces` entry gives the Worker an `env.<BINDING>` with `get`, `put`, `delete` and the
rest of the Workers KV API. CellB runs celld's own KV code (celld's `services/kv.js`, vendored as
`vendor/celld/kv.js` with only an export added), so values, limits and error messages are celld's,
and a namespace's data moves between celld and CellB with its cell.

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
1 MiB are kept outside the cell in a FilesApi (on celld, the fleet bucket), using celld's own
prepare / put / get / sweep protocol. The limits are the constants of celld's `celld_logic::kv`:
keys up to 512 bytes, values up to 25 MiB, metadata up to 1 KiB.

## How it is checked

celld's `kv` example and CellB's `kv-values` and `kv-details` projects, on Node and in Chromium.
`e2e/p11f-celld-one-bucket.test.ts` moves a namespace's data from celld to CellB and back through
one bucket.

## What breaks

Errors carry celld's messages, such as `KV_ERROR: …`.
