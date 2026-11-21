// WebSockets into containers. A container's server is reached with an upgrade request through
// `getTcpPort(port).fetch()`; an engine that supports it answers 101 and carries the socket's
// MessagePort (the convention of @statewalker/webrun-http-browser: `takeUpgrade(response)`).
import {
  createWebSocketClass,
  newWebSocketUpgradeRequest,
  type PortWebSocketClass,
  takeUpgrade,
  type WebSocketClassOptions,
} from "@statewalker/webrun-http-browser";

interface HasTcpPorts {
  getTcpPort(port: number): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

/**
 * A WHATWG `WebSocket` class whose sockets open to the server on `port` of `container`. The url's
 * host is not used: its path and query go to the server. Install it where code expects a
 * `WebSocket` (a page's live-reload client, say).
 */
export function containerWebSocket(
  container: HasTcpPorts,
  port: number,
  options?: WebSocketClassOptions,
): PortWebSocketClass {
  return createWebSocketClass(async (url, protocols) => {
    const response = await container
      .getTcpPort(port)
      .fetch(newWebSocketUpgradeRequest(url, { protocols }));
    const upgrade = takeUpgrade(response);
    if (!upgrade || response.status !== 101) {
      upgrade?.port.close();
      throw new Error(`the container refused the WebSocket: ${response.status}`);
    }
    return { port: upgrade.port, protocol: upgrade.protocol };
  }, options);
}
