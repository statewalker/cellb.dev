import type { WebSocketConnector } from "./client.js";

/**
 * Page-side connector: asks the controlling ServiceWorker (a CellRouter) to open
 * a socket and receives the socket's MessagePort in return.
 * `new (createWebSocketClass(serviceWorkerConnector()))(url)` then behaves like a
 * browser WebSocket towards a Durable Object in a shard worker.
 */
export function serviceWorkerConnector(
  sw: () => Promise<ServiceWorker> = async () => {
    const reg = await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller ?? (reg.active as ServiceWorker);
  },
): WebSocketConnector {
  return async (url, protocols) => {
    const target = await sw();
    const { port1, port2 } = new MessageChannel();
    const answer = new Promise<{
      ok: boolean;
      port?: MessagePort;
      protocol?: string;
      error?: string;
    }>((resolve) => (port1.onmessage = (e) => resolve(e.data)));
    target.postMessage({ type: "cells-ws", url, protocols }, [port2]);
    const a = await answer;
    port1.close();
    if (!a.ok || !a.port) throw new Error(a.error ?? "WebSocket refused");
    return { port: a.port, protocol: a.protocol };
  };
}
