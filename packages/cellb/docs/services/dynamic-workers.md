# Dynamic Workers (Worker Loader)

A `worker_loaders` binding runs code handed over at run time:
`env.LOADER.get(id, () => ({ compatibilityDate, mainModule, modules, env, … }))` returns a Worker
whose entrypoints the caller uses as stubs. CellB runs each loaded Worker in a realm of its own.

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
copied unchanged and run by the conformance suite on Node and in Chromium: the loaded Worker's
`console.log` reaches the Tail Worker named in `tails`.

## Where a loaded Worker runs

| Host | Realm |
|---|---|
| Node | a worker thread per loaded Worker, always |
| Browser, with `isolateScript` | a Dedicated Worker per loaded Worker (`@statewalker/cellb/isolate-worker`) |
| Browser, without `isolateScript` | the realm of the project's worker, not isolated |

In its own realm, a loaded Worker does not see the project's globals, and its `env` is what its
`WorkerCode` declares: plain values are copied, bindings become stubs whose calls go back to the
parent runtime. What this isolation does and does not protect is in [security.md](../security.md).

## What a loaded Worker can do

- Modules are source (`js`), `text`, `json` or `wasm` bytes.
- `globalOutbound: null` makes its global `fetch()` throw; a Fetcher as `globalOutbound` receives
  its fetches instead.
- Its `ctx.exports` holds its own `WorkerEntrypoint` classes; `getEntrypoint(name, { props })`
  passes `props` to `ctx.props`.
- Functions, `RpcTarget`s and stubs pass by reference into and out of it (in `env`, `props`,
  arguments and results), as on workerd; celld refuses them.
- A call's result is an RpcPromise: `stub.a().b()` sends `b` before `a()` settles.
- Its Durable Object classes run as [facets](durable-object-facets.md), inside its realm.
- An uncaught exception in it is logged, and it keeps running.

## How it is checked

celld's `dynamic-worker-tails` and `facets` examples, CellB's `isolation-api` and `runtime-api`
projects, and workerd's own Worker Loader tests (`wd-worker-loader`), on Node and in Chromium.

## What breaks

- **A `data` module is refused**, as celld refuses it:
  `worker loader: module "x" must be a string or wasm bytes`.
- **Hop-by-hop request headers do not reach it** (`Connection`, `TE`, `Keep-Alive`): a fetch into
  a loaded Worker crosses as HTTP/1.1. A WebSocket upgrade is the exception: it crosses on a
  channel of its own with all its headers, so a loaded Worker or its facet can accept WebSockets
  (partyserver does, test/p36). A 101 answer hands the host the socket's own MessagePort: its
  frames go straight to the isolate, and open sockets take none of the isolate's multiplexed
  ports (at most 4,096 at once, `globalThis.__cellbMaxPorts`). When the runtime closes, the
  isolate's sockets close with 1001 before it ends (bench/README.md has the numbers).
- **Some of workerd's Worker Loader features are missing**: `WorkerCode.compatibilityFlags`,
  `abortIsolateDynamic*`, the props of `getDurableObjectClass(name, { props })`, and
  `inheritGlobalOutbound` ([gaps.md](../gaps.md)).
- **Stubs do not cross to another node.** Arguments to an object owned by another tab, worker or
  peer are V8-serialized; a function, `RpcTarget` or stub among them is refused with
  `DataCloneError: Functions, RpcTargets and stubs cannot be sent to another node: …`.
