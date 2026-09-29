// Authored as ordinary browser code: a plain `new WebSocket(url)`.
// Served by webrun-modules, `WebSocket` resolves through ~deps to the page's host
// registry (a WebSocket-compatible class over MessagePorts), not to the native one.
export function say(
  url: string,
  text: string,
): Promise<{ reply: string; protocol: string; native: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ["lobby.v1"]);
    ws.onopen = () => ws.send(text);
    ws.onmessage = (event) => {
      resolve({
        reply: String(event.data),
        protocol: ws.protocol,
        native: ws instanceof globalThis.WebSocket,
      });
      ws.close(1000, "done");
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
}
