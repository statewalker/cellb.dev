# Workers

A Worker is a project's `main` module. Its `fetch` handler answers the requests the runtime
receives. CellB loads a project from its wrangler configuration (`wrangler.jsonc` plus its `main`)
without changes. In Node, `loadNodeProject` bundles `main` with esbuild, as `celld deploy` does; in
a browser, `browserProjectRuntime` runs it in a worker. A project with `assets` and no `main` is a
static site ([Static assets](static-assets.md)).

```jsonc
{ "name": "hello", "main": "index.js", "compatibility_date": "2026-01-01" }
```

```js
export default {
  async fetch(request, env) {
    return new Response("Hello from cells! url=" + request.url, {
      status: 200,
    });
  },
};
```

This is celld's `hello` example ([conformance/celld-examples/hello](../../conformance/celld-examples/hello/index.js)),
copied unchanged. The conformance suite runs it on CellB in Node and in Chromium and compares the
answers with celld's recording ([Conformance](../conformance.md)).

## A Worker gets the answers celld gives

- An uncaught error produces a `500` response with `content-type: application/json` and the body
  `Worker failed: rejected: <name>: <message>`. A handler that returns something other than a
  `Response` is sent as its text with status 200.
- An inbound request has `request.cf` set to `{}`.
- A promise the Worker leaves rejected stays the Worker's problem. On Node, where the Worker shares
  the host's process, CellB passes it to `onUnhandledRejection` (which by default prints one line on
  stderr) instead of the process's `unhandledRejection` listeners.
- `new Response("text")` carries `text/plain;charset=UTF-8`, because the Fetch standard adds it.
  celld sends no `Content-Type`.
- The Cache API (`caches`) always misses, as on celld, which has no shared edge cache. `put()`
  consumes the response and stores nothing, and `match()` resolves to `undefined`.
- `HTMLRewriter` is lol-html compiled to WASM (Miniflare's `html-rewriter-wasm`), loaded on first use.

## Node and browsers give a Worker different globals

- **In Node the project's Worker shares the host's realm and process.** `process.env` is the
  host's, and code that writes to `globalThis` affects the whole runtime
  ([Security & isolation](../security.md)). Under `nodejs_compat`, the project's text `vars` are
  added to `process.env` wherever the host has not already set them.
- **In a browser, `process.env` holds the project's text `vars`** under `nodejs_compat` (from
  compatibility date 2025-04-01, as on workerd; `nodejs_compat_populate_process_env` and
  `nodejs_compat_do_not_populate_process_env` override the date, on both hosts, and do nothing
  without `nodejs_compat`). `node:fs` and `node:os` load with no host behind them (`existsSync` is false, `os.cpus()` is empty). Other Node.js modules without a browser
  polyfill load as stubs that throw when called.
- **Firefox has no streaming request body.** CellB gives Worker code a `request.body` that reads the
  whole body first. If the Worker forwards it as the body of another request, Firefox sends the text
  `[object ReadableStream]` ([Gaps](../gaps.md#firefox-and-webkit)).

## How it is checked

celld's `hello`, `webapi`, `router` and `body` examples, and CellB's `worker-details`,
`runtime-api` and `node-compat` projects, on Node and in Chromium.

## What breaks

- **Configuration CellB does not support is reported in `createProjectRuntime(...).unsupported`**
  instead of being silently ignored. [Gaps](../gaps.md#other-gaps) has the full list, from
  service bindings to other scripts to compatibility flags CellB does not know. Browser tabs log it as
  `cellb: project … shard …: unsupported: …`.
- **Python Workers do not run**, because CellB does not include Pyodide.
