import { createWebSocketClass as createPortWebSocketClass } from "@statewalker/webrun-http-browser/sw";

/** Opens the transport of a socket: resolves with the MessagePort once the server accepted (101). */
export type WebSocketConnector = (
  url: string,
  protocols: string[],
) => Promise<{ port: MessagePort; protocol?: string }>;

type IntervalTimers = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
};

/** The longest period a timer takes (2³¹−1 ms, about 24.8 days): `heartbeatMs: 0` pings that rarely. */
const LONGEST_PERIOD_MS = 2 ** 31 - 1;

export interface CellsWebSocketOptions {
  /**
   * Liveness ping period (ms, default 10 s); 0 disables the heartbeat. The peer is declared dead
   * after 2 periods without a pong.
   */
  heartbeatMs?: number;
  /**
   * Timers for the heartbeat (and, when given, the close handshake's timeout). On a page's main
   * thread pass worker-timers' functions: background-tab throttling of main-thread timers would
   * otherwise delay pings and make the server drop a live socket. Workers and Node do not
   * throttle, so the built-in timers are the default.
   */
  timers?: IntervalTimers & {
    setTimeout?(fn: () => void, ms: number): unknown;
    clearTimeout?(id: unknown): void;
  };
  /** How long `close()` waits for the server's echo before closing with 1006 (default 5 s). */
  closeTimeoutMs?: number;
}

/**
 * A WHATWG `WebSocket` class whose sockets reach a Worker through `connect` (page →
 * ServiceWorker → the shard worker that owns the object, or in-process). It is
 * `@statewalker/webrun-http-browser`'s client (`createWebSocketClass`): the socket's frames on its
 * MessagePort are that package's (version `WS_PORT_PROTOCOL_VERSION`), which the server ends of
 * cellb's WebSocketPairs speak. Installed for user code through webrun-modules `~deps` (provided
 * `WebSocket`), so the real `globalThis.WebSocket` is left untouched. Typed as the platform's
 * `WebSocket` (the class implements that interface).
 */
export function createWebSocketClass(
  connect: WebSocketConnector,
  options: CellsWebSocketOptions = {},
): typeof WebSocket {
  const { timers } = options;
  const setTimer = timers?.setTimeout?.bind(timers) ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    timers?.clearTimeout?.bind(timers) ??
    ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  return createPortWebSocketClass(
    async (url, protocols) => {
      const { port, protocol } = await connect(url, protocols);
      return { port, protocol: protocol ?? "" };
    },
    {
      heartbeatMs: options.heartbeatMs === 0 ? LONGEST_PERIOD_MS : options.heartbeatMs,
      closeTimeoutMs: options.closeTimeoutMs,
      timers: timers && {
        setInterval: (fn, ms) => timers.setInterval(fn, ms),
        clearInterval: (id) => timers.clearInterval(id),
        setTimeout: setTimer,
        clearTimeout: clearTimer,
      },
    },
  ) as unknown as typeof WebSocket;
}

export type CellsWebSocketClass = ReturnType<typeof createWebSocketClass>;
