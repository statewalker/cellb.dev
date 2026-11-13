---
"@statewalker/cellb": patch
---

Worker Loader and Workers behaviours of workerd that CellB lacked (found running Cloudflare's Kitesurf browser engine Worker on CellB):

- A class as the default export (`export default class extends WorkerEntrypoint`) answers `fetch`, `scheduled` and `queue` with an instance per event, built with `(ctx, env)`; the static assets router passes it the requests the assets do not answer. Before, such a Worker answered "Worker has no fetch handler", and with assets every miss was a 404.
- A wasm import (`CompiledWasm` rule) is compiled synchronously, as workerd imports one. Its top-level `await WebAssembly.compile` made every importer async, and with circular imports and a dynamic `import()` esbuild's async module inits waited on each other: `loadProject` never settled.
- Worker Loader `{ cjs }` modules: not in strict mode unless they say so, `this` is `module.exports`, and an import gives `module.exports` as the default export. Before, the module was `undefined`.
- `abortIsolate(reason)` of `cloudflare:workers`: in a loaded Worker's isolate, the call and the calls in flight reject with `internal error; reference = …`, the isolate ends, and the next `get()` of its id loads the code again (workerd's `abortIsolateDynamic` test). Before, code importing it did not build.
- `stub.dup()` on stubs that cross into an isolate gives another stub of the same value, released on its own; on Durable Object and other in-realm stubs it gives the stub. Before, `dup` was sent as a remote method call.
- `Request`, `Response`, `Headers` and `ReadableStream` values cross an isolate in arguments and results, as on workerd; bodies stream over a port of their own when read, and a body cancelled unread is cancelled on the sending side. Before, they failed with `DataCloneError`. In one realm, a call passes a Request, Response or stream itself and copies Headers.
- A loaded Worker's isolate lets its code assign `navigator` (Node's and a Dedicated Worker's are getters).
- `Uint8Array.prototype.toBase64`/`toHex` and `Uint8Array.fromBase64`/`fromHex` where the engine lacks them (Node 22).
