/// <reference lib="webworker" />
// P05b — the single "server" of the origin: a ServiceWorker holding a CellRouter.
// It cannot create workers (no Worker/SharedWorker in SW scope), so pages spawn
// shard workers and hand the SW two MessagePorts per shard.
import { CellRouter, linkOverPort, serveHandlerOverPort } from "../../src/index.js";
import { SHARDS } from "./config.js";
import { createModules } from "./modules.js";

declare const self: ServiceWorkerGlobalScope;
const bootId = Math.random().toString(36).slice(2, 8); // changes when the SW is restarted

const router = new CellRouter({
  shards: SHARDS,
  bindings: { COUNTER: "Counter", ROOM: "Room", LOBBY: "Lobby" },
  attachTimeoutMs: 15_000,
  onMissingShard: () => void askForLinks(),
  // No MessagePort close event in Chromium: the owner worker's own Web Lock is the
  // liveness signal. Event-driven watch first; polling kept as a safety net.
  watchOwner: (_shard, ownerLock) => navigator.locks.request(ownerLock as string, async () => {}),
  isAlive: async (_shard, ownerLock) =>
    !!(await navigator.locks.query()).held?.some((l) => l.name === ownerLock),
  livenessIntervalMs: 5_000,
});

let asking: Promise<void> | undefined;
function askForLinks(): Promise<void> {
  asking ??= self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((cs) => {
      for (const c of cs) c.postMessage({ type: "cells-need-links" });
    })
    .finally(() => setTimeout(() => (asking = undefined), 500));
  return asking;
}

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const m = e.data;
  if (m?.type === "cells-ws") return void e.waitUntil(openSocket(m, e.ports[0]));
  if (m?.type !== "cells-attach") return;
  e.waitUntil(
    (async () => {
      await serveHandlerOverPort(m.up, router.internal);
      const link = await linkOverPort(m.down);
      router.attach(m.shard, link.send, m.ownerLock, m.ctl); // token = the owner worker's own lock
      (e.source as Client | null)?.postMessage({ type: "cells-attached", shard: m.shard });
    })(),
  );
});

const scope = new URL(self.registration.scope);
const CELLS = `${scope.pathname}cells/`;
const MODULES = `${scope.pathname}modules/`;
const modules = createModules(MODULES);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== scope.origin) return;
  if (url.pathname === `${scope.pathname}__router`)
    return e.respondWith(Response.json({ bootId, attached: router.attachedShards }));
  if (url.pathname.startsWith(MODULES))
    return e.respondWith(modules.then((m) => m.fetch(e.request)));
  if (!url.pathname.startsWith(CELLS)) return;
  const req = e.request;
  const target = new URL(`/${url.pathname.slice(CELLS.length)}${url.search}`, url.origin);
  e.respondWith(
    router.ingress(
      new Request(target, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: "half",
      } as RequestInit),
    ),
  );
});

/**
 * WebSocket ingress. A ServiceWorker never sees WebSocket connections, so pages
 * ask for a socket by message: the router has a shard run the Worker's fetch with
 * an Upgrade request and the client end's port travels back to the page.
 */
async function openSocket(
  m: { url: string; protocols?: string[] },
  reply: MessagePort,
): Promise<void> {
  try {
    const url = new URL(m.url);
    if (!url.pathname.startsWith(CELLS)) throw new Error(`not a cells URL: ${m.url}`);
    url.pathname = `/${url.pathname.slice(CELLS.length)}`;
    const { port, protocol } = await router.connectWebSocket(url.toString(), m.protocols ?? []);
    reply.postMessage({ ok: true, port, protocol }, [port]);
  } catch (err) {
    reply.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
}
