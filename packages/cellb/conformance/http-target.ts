import type { Target } from "./scenarios.ts";

/** A scenario target behind a real HTTP origin (celld dev, or workerd through Miniflare). */
export function httpTarget(origin: string, wsServer?: string): Target {
  return {
    origin,
    wsServer,
    fetch: (req) => fetch(req),
    websocket: (url) =>
      new Promise((resolveWs, reject) => {
        const ws = new WebSocket(url);
        const queue: unknown[] = [];
        const waiters: ((v: unknown) => void)[] = [];
        ws.onmessage = (e) => (waiters.length ? waiters.shift()!(e.data) : queue.push(e.data));
        ws.onerror = () => reject(new Error("websocket error"));
        ws.onopen = () =>
          resolveWs({
            send: (m) => ws.send(m),
            next: () =>
              queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
            close: () => ws.close(),
          });
      }),
  };
}
