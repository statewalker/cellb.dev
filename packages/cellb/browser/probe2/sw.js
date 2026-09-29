self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const closed = [];
self.addEventListener("message", async (e) => {
  const m = e.data;
  if (m.type === "port") {
    m.port.addEventListener("close", () => closed.push(m.id));
    m.port.start();
  } else if (m.type === "query") {
    const q = await navigator.locks.query();
    const held = await Promise.all(
      q.held.map(async (l) => ({
        name: l.name,
        clientId: l.clientId,
        alive: !!(await self.clients.get(l.clientId)),
      })),
    );
    e.source.postMessage({
      closed,
      held,
      pending: q.pending.map((l) => l.name),
      syncHandle:
        typeof FileSystemFileHandle !== "undefined" &&
        "createSyncAccessHandle" in FileSystemFileHandle.prototype,
      onclose: "onclose" in MessagePort.prototype,
    });
  }
});
