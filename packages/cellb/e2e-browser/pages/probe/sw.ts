/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;
const bootId = Math.random().toString(36).slice(2, 8);
const bootAt = Date.now();
const lost: Record<string, number> = {};
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  const m = e.data;
  const reply = (v: unknown) => e.ports[0]?.postMessage(v);
  if (m?.type === "watch") {
    // Pending request on the owner's lock: granted exactly when the owner's tab/worker dies.
    self.navigator.locks.request(m.name, async () => {
      lost[m.name] = Date.now();
    });
    reply("watching");
  } else if (m?.type === "lost") reply(lost[m.name] ?? null);
  else if (m?.type === "boot") reply({ bootId, age: Date.now() - bootAt });
  else if (m?.type === "ping") e.waitUntil(Promise.resolve());
});
