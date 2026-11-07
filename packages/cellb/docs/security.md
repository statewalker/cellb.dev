# Security and isolation

CellB is a library: the embedder decides what code it runs and where. This page says what CellB
isolates, what it leaves shared, and what each setting exposes, so that the boundary is a choice and
not an assumption. Terms are those of [CONTEXT.md](../CONTEXT.md).

## The project's own Worker is trusted code

The project's Worker and its Durable Objects run in the host's realm, not in an isolate:

- **In Node** they share the host's process: `process`, `process.env`, the module cache, and every
  global. Code that writes to `globalThis` affects the whole runtime.
- **In a browser** they share the worker that hosts the project, and so the origin: its OPFS,
  IndexedDB, cookies through the router, and the network.

Run as a project only code you would run in the host itself.

## A loaded Worker is isolated from the project, not from the platform

Code handed over at run time through a Worker Loader binding ([Dynamic Workers](services/dynamic-workers.md))
runs in a realm of its own:

| Host | Realm of a loaded Worker |
|---|---|
| Node | a worker thread, always |
| Browser, with `isolateScript` | a Dedicated Worker of its own |
| Browser, without `isolateScript` | **none: the project's realm** |

In its own realm a loaded Worker does not see the project's globals or `env`. Its `env` holds what
its `WorkerCode` declares: plain values are copied, and bindings become stubs whose every call goes
back to the parent runtime. A loaded Worker therefore reaches the project's storage, other objects
and services only through what it was given.

What that realm does **not** take away:

- **The platform's own APIs.** A Dedicated Worker runs on the page's origin, with the origin's
  storage APIs and network; a worker thread runs in the host's Node process.
- **The network, beyond `fetch`.** `globalOutbound: null` replaces the global `fetch()` with one that
  throws; a Fetcher as `globalOutbound` receives its fetches. Neither removes the platform's other
  network APIs, such as the `WebSocket` global.
- **CPU, memory and storage.** CellB enforces no limits per Worker or per object. Calls into a loaded
  Worker have no timeout, and one that never returns holds its caller.

Running untrusted code needs more than CellB gives: an opaque-origin iframe or a separate origin in
a browser (out of CellB's scope, [gaps.md](gaps.md#out-of-scope-on-purpose)), a separate process
or container on a server.

## What an origin's pages share

- **Cookies passed through `installProjectRouter` are readable by the page and are all `Path=/`.**
  Browsers drop `Cookie` and `Set-Cookie` from the requests and responses that script builds, so the
  router stores the Worker's cookies with the Cookie Store API; cookies written by script cannot be
  `HttpOnly` ([browser-host.md](browser-host.md#what-breaks)).
- **Cells in OPFS belong to the origin.** Any page or worker of the origin can open the same storage.

## What a fleet bucket's credentials grant

- **A page's S3 credentials are visible to its user.** A browser node signs each request itself, so
  its key is in the page, with a same-origin proxy too. Give it a key limited to the bucket and
  prefix ([browser-host.md](browser-host.md)).
- **Bucket access is fleet access.** The fleet's peer secret is an object in the bucket
  (`fleet/peer-auth.json`); CellB reads it from there to authenticate celld's peer requests. A key
  that can read the fleet's prefix can read that secret.
- **Peer requests are authenticated** (Node): `startCelldPeerServer` checks each one with the fleet's
  HMAC-SHA-256 secret, within ±30 s, against a nonce replay cache, for this node
  ([celld-compatibility.md](celld-compatibility.md#a-mixed-fleet-cellb-as-a-celld-peer-node)).

## What breaks

- **A public endpoint mounted on `cellsHttpHandler` lets clients address any object directly** with
  `x-cellb*` headers. Mount `runtime.fetch` (or `CellRouter.ingress`, which strips those headers) on
  public ingress, and `cellsHttpHandler` only on internal links. `installProjectRouter` strips them
  (in any letter case) from the pages' requests and sockets before they reach the shards. That
  guards against what a page sends, not against a page: the router trusts every same-origin page.
  Any of them can attach a handler of its own (webrun-http-browser's adapter), claim a shard's
  slot, and send it requests with any headers. Serve only code you trust on the origin.
- **A loaded Worker on a browser site without `isolateScript` is not isolated at all**: it shares
  the project's realm and module registry. Pass `isolateScript` (the package ships
  `@statewalker/cellb/isolate-worker`) whenever loaded code is not your own.
