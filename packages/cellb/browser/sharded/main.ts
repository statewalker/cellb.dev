// P05b — page side: competes for shard ownership with Web Locks; the tab holding
// the lock of shard i runs its worker and attaches it to the ServiceWorker router.
import { createWebSocketClass, serviceWorkerConnector } from "../../src/index.js";
import { SHARDS } from "./config.js";

// Host registry of THIS realm: what webrun-modules' ~deps proxies of page code resolve to.
// WebSocket = a WebSocket-compatible class whose transport is a MessagePort from the SW.
(globalThis as any).__webrunHostRegistry = new Map<string, unknown>([
  ["WebSocket", createWebSocketClass(serviceWorkerConnector(), { heartbeatMs: 1_000 })],
  ["WebSocketPair", undefined],
  ["Response", Response],
]);
Object.assign(window, {
  /** Imports user code served by webrun-modules from the ServiceWorker. */
  __importUser: (path: string) =>
    import(/* @vite-ignore */ `${location.origin}/sharded/modules/~/${path}`),
  __CellsWebSocket: (globalThis as any).__webrunHostRegistry.get("WebSocket"),
  /**
   * Runs one case of test/ws-conformance.ts in this page against the native browser
   * WebSocket (talking to a real server at `nativeBase`) or webrun-cells sockets
   * (SW router → shard workers → Room Durable Object).
   */
  __wsCase: async (impl: "native" | "cells", name: string, nativeBase: string) => {
    const { cases } = await import("../../test/ws-conformance.js");
    const wsOrigin = location.origin.replace(/^http/, "ws");
    const env =
      impl === "native"
        ? {
            WS: WebSocket,
            room: (n: string) => `${nativeBase}/room/${n}`,
            refused: `${nativeBase}/nope`,
            label: impl,
          }
        : {
            WS: (globalThis as any).__webrunHostRegistry.get("WebSocket"),
            room: (n: string) => `${wsOrigin}/sharded/cells/room/${n}`,
            refused: `${wsOrigin}/sharded/cells/nope/x`,
            label: impl,
          };
    try {
      await cases[name](env);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  },
});

const owned = new Map<number, Worker>();
const log = (msg: string) => (document.getElementById("log")!.textContent += `${msg}\n`);

async function swReady(): Promise<ServiceWorker> {
  const reg = await navigator.serviceWorker.register(new URL("./sw.ts", import.meta.url), {
    type: "module",
    scope: "./",
  });
  await navigator.serviceWorker.ready;
  return (reg.active ?? (await navigator.serviceWorker.ready).active)!;
}

function once(
  target: Worker | ServiceWorkerContainer,
  type: string,
  pred: (d: any) => boolean = () => true,
): Promise<any> {
  return new Promise((r) => {
    const h = (e: MessageEvent) => {
      if (e.data?.type === type && pred(e.data)) {
        target.removeEventListener("message", h as any);
        r(e.data);
      }
    };
    target.addEventListener("message", h as any);
  });
}

const ownerLocks = new Map<Worker, string>();

async function attach(shard: number, w: Worker): Promise<void> {
  const down = new MessageChannel(); // router → shard
  const up = new MessageChannel(); // shard → router
  const ctl = new MessageChannel(); // WebSocket port hand-over
  const linked = once(w, "linked");
  w.postMessage({ type: "link", down: down.port2, up: up.port2, ctl: ctl.port2 }, [
    down.port2,
    up.port2,
    ctl.port2,
  ]);
  await linked;
  const sw = await swReady();
  const attached = once(navigator.serviceWorker, "cells-attached", (d) => d.shard === shard);
  sw.postMessage(
    {
      type: "cells-attach",
      shard,
      ownerLock: ownerLocks.get(w),
      down: down.port1,
      up: up.port1,
      ctl: ctl.port1,
    },
    [down.port1, up.port1, ctl.port1],
  );
  await attached;
}

async function own(shard: number): Promise<void> {
  await navigator.locks.request(`webrun-cells:shard:${shard}`, async () => {
    const w = new Worker(new URL("./shard-worker.ts", import.meta.url), { type: "module" });
    const ready = once(w, "ready");
    w.postMessage({ type: "init", shard, shards: SHARDS });
    ownerLocks.set(w, (await ready).ownerLock);
    owned.set(shard, w);
    await attach(shard, w);
    log(`owner of shard ${shard}`);
    document.body.dataset.owned = [...owned.keys()].sort().join(",");
    await new Promise(() => {}); // hold the lock for the life of this tab
  });
}

navigator.serviceWorker.addEventListener("message", (e) => {
  if (e.data?.type === "cells-need-links") for (const [shard, w] of owned) void attach(shard, w); // SW restarted
});

(async () => {
  await swReady();
  document.body.dataset.ready = "true";
  // ?passive: a client of the cells that never competes for shard ownership.
  if (!new URL(location.href).searchParams.has("passive"))
    for (let s = 0; s < SHARDS; s++) void own(s);
})().catch((e) => (document.body.dataset.error = String(e?.stack ?? e)));
