# Dynamic Workers (Worker Loader)

A `worker_loaders` binding runs code that is handed over at run time.
`env.LOADER.get(id, () => ({ compatibilityDate, mainModule, modules, env, … }))` returns a Worker
whose entrypoints the caller uses as stubs. CellB runs each loaded Worker in a realm of its own
on Node, and in a browser when the runtime has an `isolateScript` (see the table below).

```jsonc
{
  "name": "dynamic-worker-tails",
  "main": "index.js",
  "compatibility_date": "2026-01-01",
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

```js
import { WorkerEntrypoint } from "cloudflare:workers";

const WORKER_ID = "hello-v1";
const WORKER_MAIN = "worker.js";
const WORKER_SOURCE = `
  export default {
    fetch() {
      console.log("hello from loaded code");
      return new Response("Hello from a Dynamic Worker!\\n");
    }
  };
`;

export class DynamicWorkerTail extends WorkerEntrypoint {
  tail(events) {
    for (const event of events) {
      for (const log of event.logs) {
        console.log(`dynamic-worker-tail: ${log.message.join(" ")}`, {
          workerId: this.ctx.props.workerId,
          level: log.level,
        });
      }
    }
  }
}

export default {
  fetch(request, env, ctx) {
    const worker = env.LOADER.get(WORKER_ID, () => ({
      compatibilityDate: "2025-01-01",
      mainModule: WORKER_MAIN,
      modules: { [WORKER_MAIN]: WORKER_SOURCE },
      tails: [
        ctx.exports.DynamicWorkerTail({
          props: { workerId: WORKER_ID },
        }),
      ],
    }));
    return worker.getEntrypoint().fetch(request);
  },
};
```

This is celld's `dynamic-worker-tails` example ([conformance/celld-examples/dynamic-worker-tails](../../conformance/celld-examples/dynamic-worker-tails/index.js)),
copied unchanged and run by the conformance suite on Node and in Chromium. The loaded Worker's
`console.log` output reaches the Tail Worker named in `tails`.

## Where a loaded Worker runs

| Host | Realm |
|---|---|
| Node (`loadProject`, `loadNodeProject`) | a worker thread per loaded Worker, always |
| Browser, with `isolateScript` | a Dedicated Worker per loaded Worker (`@statewalker/cellb/isolate-worker`) |
| Browser, without `isolateScript` | the realm of the project's worker, not isolated |

Whether a loader sets `isolateScript` for you depends on the entry point:

| Entry point | Loaded Workers isolated by default? |
|---|---|
| `loadProject` from `@statewalker/cellb/node` | yes, a worker thread each |
| `loadNodeProject` | yes, a worker thread each |
| `loadProject` from `@statewalker/cellb/browser` | yes, a Dedicated Worker each (the package's isolate worker); `isolateScript: false` turns it off |
| `browserProjectRuntime` (also with `site`) | no: only with `isolateScript` |
| `startProjectShards`, `joinProjectShards` | no: only when the shard worker calls `serveProjectShard({ isolateScript })` |
| `createProjectRuntime` | no: only when the host passes `isolatedModules` (the loaders above do) |

In its own realm, a loaded Worker does not see the project's globals, and its `env` holds only what
its `WorkerCode` declares. Plain values are copied, and bindings become stubs whose calls go back to
the parent runtime. [Security & isolation](../security.md) explains what this isolation does and
does not protect.

## What a loaded Worker can do

- Modules can be source code (`js`), CommonJS (`cjs`), `text`, `json` or `wasm` bytes. A CommonJS
  module runs as on workerd: not in strict mode unless it says so, with `this` as `module.exports`,
  and an import of it gives `module.exports` as the default export.
- `globalOutbound: null` makes its global `fetch()` throw; a Fetcher as `globalOutbound` receives
  its fetches instead.
- Its `ctx.exports` holds its own `WorkerEntrypoint` classes; `getEntrypoint(name, { props })`
  passes `props` to `ctx.props`.
- Functions, `RpcTarget`s and stubs pass by reference into and out of it (in `env`, `props`,
  arguments and results), as on workerd. celld refuses them. `stub.dup()` gives another stub of
  the same value, released on its own.
- `Request`, `Response`, `Headers` and `ReadableStream` values cross in arguments and results, as
  on workerd. A body streams across when the receiver reads it, over a port of its own; one the
  receiver cancels, or drops and is collected, is cancelled on the side that sent it.
- `abortIsolate(reason)` of `cloudflare:workers` ends its isolate, as on workerd: the call rejects
  with `internal error; reference = …`, so do the calls in flight, and the next `get()` of the
  same id loads the code again. In a loaded Worker that runs in the project's realm (a browser
  without `isolateScript`), there is no isolate to end, and the call only throws.
- Its realm's `navigator` is writable, as on workerd, and `Uint8Array` has `toBase64`,
  `fromBase64`, `toHex` and `fromHex` where the engine lacks them (Node 22).
- A call's result is an RpcPromise: `stub.a().b()` sends `b` before `a()` settles.
- Its Durable Object classes run inside its realm as facets ([Durable Object
  facets](durable-object-facets.md)).
- An uncaught exception in it is logged, and it keeps running.

## How it is checked

celld's `dynamic-worker-tails` and `facets` examples, CellB's `isolation-api` and `runtime-api`
projects, and workerd's own Worker Loader tests (`wd-worker-loader`), on Node and in Chromium.

## What breaks

- **A `data` module is refused**, as on celld, with
  `worker loader: module "x" must be a string or wasm bytes`.
- **Hop-by-hop request headers (`Connection`, `TE`, `Keep-Alive`) do not reach it**, because a
  fetch into a loaded Worker crosses as HTTP/1.1. A WebSocket upgrade is the exception. It crosses
  on a channel of its own with all its headers, so a loaded Worker or its facet can accept
  WebSockets, as partyserver does in `test/p36-partyserver.test.ts`. A 101 answer hands the host
  the socket's own MessagePort, so its frames go straight to the isolate and open sockets do not
  use up the isolate's multiplexed ports (4,096 at most by default, which
  `globalThis.__cellbMaxPorts` overrides). When the runtime closes, the isolate's sockets are closed with
  code 1001 before the isolate ends. [Benchmarks](../../bench/README.md) has the numbers.
- **Some of workerd's Worker Loader features are missing**: `WorkerCode.compatibilityFlags`, the
  props of `getDurableObjectClass(name, { props })`, and `inheritGlobalOutbound`
  ([Gaps](../gaps.md)). `WorkerCode.limits` (CPU time, subrequests) is ignored: limits per object
  are out of scope.
- **Stubs do not cross to another node.** Arguments to an object owned by another tab, worker or
  peer are V8-serialized, and a function, `RpcTarget` or stub among them is refused with
  `DataCloneError: Functions, RpcTargets and stubs cannot be sent to another node: …`.
