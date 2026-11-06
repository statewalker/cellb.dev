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
  const Base = createPortWebSocketClass(
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
  );
  // Two of cellb's own client's rules the package's does not apply.
  class CellsWebSocket extends Base {
    constructor(url: string | URL, protocols: string | string[] = []) {
      const list = typeof protocols === "string" ? [protocols] : [...protocols];
      // Subprotocols are duplicates case-insensitively (WHATWG; WPT
      // Create-protocols-repeated-case-insensitive).
      const seen = new Set<string>();
      for (const p of list) {
        const key = p.toLowerCase();
        if (seen.has(key))
          throw new DOMException(`The subprotocol '${p}' is duplicated.`, "SyntaxError");
        seen.add(key);
      }
      super(resolved(url), list);
    }
  }
  return CellsWebSocket as unknown as typeof WebSocket;
}

/**
 * A relative url resolved against the page, or, where there is none (Node, a worker without
 * `location`), against `http://localhost/`, as cellb's client always did. An url that does not
 * parse is passed on, for the class to refuse with its SyntaxError.
 */
function resolved(url: string | URL): string | URL {
  if ((globalThis as { location?: unknown }).location) return url;
  try {
    return new URL(String(url), "http://localhost/").href;
  } catch {
    return url;
  }
}

export type CellsWebSocketClass = ReturnType<typeof createWebSocketClass>;
