import {
  CellsCloseEvent,
  checkClose,
  DEFAULT_HEARTBEAT_MS,
  type Frame,
  toFrameData,
} from "./frames.js";

/** Opens the transport of a socket: resolves with the MessagePort once the server accepted (101). */
export type WebSocketConnector = (
  url: string,
  protocols: string[],
) => Promise<{ port: MessagePort; protocol?: string }>;

type Handler = ((ev: any) => void) | null;

/**
 * A WHATWG-WebSocket-compatible class whose transport is a MessagePort obtained
 * from `connect` (page → ServiceWorker → owning shard worker, or in-process).
 * Installed for user code through webrun-modules `~deps` (provided `WebSocket`),
 * so the real `globalThis.WebSocket` is left untouched.
 */
/** RFC 7230 token (subprotocol names). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface CellsWebSocketOptions {
  /** Liveness ping period (ms); 0 disables. The peer is declared dead after 2 missed periods. */
  heartbeatMs?: number;
}

export function createWebSocketClass(
  connect: WebSocketConnector,
  options: CellsWebSocketOptions = {},
) {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  return class CellsWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readonly url: string;
    readyState = 0;
    protocol = "";
    extensions = "";
    bufferedAmount = 0;
    binaryType: "blob" | "arraybuffer" = "blob";
    onopen: Handler = null;
    onmessage: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    #port: MessagePort | undefined;
    #pendingClose: { code?: number; reason?: string } | undefined;
    #beat: ReturnType<typeof setInterval> | undefined;
    #lastPong = 0;

    #startHeartbeat(): void {
      if (!heartbeatMs) return;
      this.#lastPong = Date.now();
      this.#beat = setInterval(() => {
        if (this.readyState >= 3) return this.#stopHeartbeat();
        if (Date.now() - this.#lastPong > 2 * heartbeatMs) return this.#fail(); // peer gone
        this.#port?.postMessage({ t: "p", hb: heartbeatMs } satisfies Frame);
      }, heartbeatMs);
      this.#port?.postMessage({ t: "p", hb: heartbeatMs } satisfies Frame);
    }
    #stopHeartbeat(): void {
      clearInterval(this.#beat);
      this.#beat = undefined;
    }

    constructor(url: string | URL, protocols: string | string[] = []) {
      super();
      // WHATWG "new WebSocket(url, protocols)" validation, in spec order.
      let u: URL;
      try {
        u = new URL(String(url), (globalThis as any).location?.href ?? "http://localhost/");
      } catch {
        throw new DOMException(`The URL '${String(url)}' is invalid.`, "SyntaxError");
      }
      if (u.protocol === "http:") u.protocol = "ws:";
      if (u.protocol === "https:") u.protocol = "wss:";
      if (u.protocol !== "ws:" && u.protocol !== "wss:")
        throw new DOMException(`The URL's scheme must be either 'ws' or 'wss'.`, "SyntaxError");
      if (u.hash || String(url).includes("#"))
        throw new DOMException("The URL contains a fragment identifier.", "SyntaxError");
      const list = typeof protocols === "string" ? [protocols] : [...protocols];
      const seen = new Set<string>();
      for (const p of list) {
        if (!TOKEN.test(p))
          throw new DOMException(`The subprotocol '${p}' is invalid.`, "SyntaxError");
        if (seen.has(p.toLowerCase()))
          throw new DOMException(`The subprotocol '${p}' is duplicated.`, "SyntaxError");
        seen.add(p.toLowerCase());
      }
      this.url = u.toString();
      connect(this.url, list).then(
        ({ port, protocol }) => this.#opened(port, protocol ?? ""),
        () => this.#fail(),
      );
    }

    #emit(ev: Event, handler: Handler): void {
      handler?.call(this, ev);
      this.dispatchEvent(ev);
    }

    #opened(port: MessagePort, protocol: string): void {
      if (this.readyState === 3) {
        port.close();
        return;
      }
      this.#port = port;
      this.protocol = protocol;
      port.onmessage = (e) => this.#frame(e.data as Frame);
      port.start?.();
      if (this.#pendingClose) {
        // close() was called while connecting
        this.readyState = 2;
        port.postMessage({
          t: "c",
          code: this.#pendingClose.code ?? 1000,
          reason: this.#pendingClose.reason ?? "",
        } satisfies Frame);
        return;
      }
      this.readyState = 1;
      this.#startHeartbeat();
      this.#emit(new Event("open"), this.onopen);
    }

    #fail(): void {
      if (this.readyState === 3) return;
      this.#stopHeartbeat();
      this.#port?.close();
      this.readyState = 3;
      this.#emit(new Event("error"), this.onerror);
      this.#emit(
        new CellsCloseEvent("close", { code: 1006, reason: "", wasClean: false }),
        this.onclose,
      );
    }

    #frame(f: Frame): void {
      if (f.t === "q") {
        this.#lastPong = Date.now();
        return;
      }
      if (f.t === "p") return;
      if (f.t === "m") {
        if (this.readyState !== 1) return;
        let data: unknown = f.d;
        if (typeof data !== "string" && this.binaryType === "blob")
          data = new Blob([data as ArrayBuffer]);
        this.#emit(
          new MessageEvent("message", { data, origin: new URL(this.url).origin }),
          this.onmessage,
        );
      } else {
        const echo = this.readyState === 1;
        if (echo)
          this.#port!.postMessage({ t: "c", code: f.code, reason: f.reason } satisfies Frame); // close handshake
        this.readyState = 3;
        this.#stopHeartbeat();
        this.#port!.close();
        this.#emit(
          new CellsCloseEvent("close", { code: f.code, reason: f.reason, wasClean: true }),
          this.onclose,
        );
      }
    }

    send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
      if (this.readyState === 0)
        throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== 1) return; // spec: silently discarded after closing
      if (data instanceof Blob) {
        void data
          .arrayBuffer()
          .then(
            (b) =>
              this.readyState === 1 &&
              this.#port!.postMessage({ t: "m", d: b } satisfies Frame, [b]),
          );
        return;
      }
      const d = toFrameData(data);
      this.#port!.postMessage({ t: "m", d } satisfies Frame, typeof d === "string" ? [] : [d]);
    }

    close(code?: number, reason?: string): void {
      checkClose(code, reason);
      if (this.readyState >= 2) return;
      if (this.readyState === 0) {
        this.#pendingClose = { code, reason };
        this.readyState = 2;
        return;
      }
      this.readyState = 2;
      this.#port!.postMessage({ t: "c", code: code ?? 1005, reason: reason ?? "" } satisfies Frame);
    }
  };
}

export type CellsWebSocketClass = ReturnType<typeof createWebSocketClass>;
