/**
 * Wire protocol of a WebSocket carried by a MessagePort (both directions):
 * `@statewalker/webrun-http-browser`'s frames (version `WS_PORT_PROTOCOL_VERSION`), spoken by its
 * client (`createWebSocketClass`) and by the ends of cellb's WebSocketPairs.
 *
 *   m  a message (an ArrayBuffer is transferred)
 *   c  close, initiating or echo
 *   p  ping (client → server), carries the client's heartbeat period
 *   q  pong (server → client)
 *   a  ack: the receiver dispatched `n` more bytes of messages (the sender's `bufferedAmount`)
 *
 * MessagePorts never report that the other side died (no `close` event in browsers), so both
 * ends run a heartbeat: the client pings every `hb` ms and closes with 1006 when pongs stop for
 * 2·hb; the server closes with 1006 when pings stop for 3·hb. This is what makes a socket notice a
 * closed tab. A hidden tab's client announces a longer period (its timers are throttled).
 */
export type Frame =
  | { t: "m"; d: string | ArrayBuffer }
  | { t: "c"; code: number; reason: string }
  | { t: "p"; hb: number }
  | { t: "q" }
  | { t: "a"; n: number };
// Declared here, not imported from webrun-http-browser/sw: its declarations name ServiceWorker
// types, and cellb's must compile with the DOM lib alone (scripts/pack-check.mjs). The two are
// kept the same by test/p07w-websocket.test.ts.

/** What a message adds to the sender's `bufferedAmount` (WHATWG: UTF-8 bytes of a string). */
export function byteSize(d: string | ArrayBuffer): number {
  return typeof d === "string" ? new TextEncoder().encode(d).byteLength : d.byteLength;
}

export function toFrameData(data: unknown): string | ArrayBuffer {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data))
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  throw new TypeError(
    "WebSocket.send: unsupported data type (string, ArrayBuffer or ArrayBufferView)",
  );
}

export function checkClose(code?: number, reason?: string): void {
  if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
    throw new DOMException(
      `The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
      "InvalidAccessError",
    );
  if (reason !== undefined && new TextEncoder().encode(reason).byteLength > 123)
    throw new DOMException(
      "The close reason must not be greater than 123 UTF-8 bytes.",
      "SyntaxError",
    );
}

/** CloseEvent is not a global in every runtime (Node 22): a compatible Event subclass. */
export class CellsCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) {
    super(type);
    this.code = init.code ?? 1005;
    this.reason = init.reason ?? "";
    this.wasClean = init.wasClean ?? false;
  }
}

/** One side of a frame relay: a MessagePort, or a port of a multiplexer. */
export interface FrameEnd {
  post(f: Frame): void;
  listen(fn: (f: Frame) => void): void;
  close(): void;
}

export const portEnd = (port: MessagePort): FrameEnd => ({
  post: (f) => port.postMessage(f),
  listen: (fn) => {
    port.onmessage = (e) => fn(e.data as Frame);
  },
  close: () => port.close(),
});

/**
 * Relays a socket's frames between `a` and `b`. Once a close frame has passed each way (the
 * closing handshake) both ends are closed, after a moment for the last frames to arrive.
 * Returns a function that ends the relay at once, telling `a` the socket closed with `code`;
 * `onDone` runs when the relay ends either way.
 */
export function relayFrames(
  a: FrameEnd,
  b: FrameEnd,
  onDone?: () => void,
): (code: number, reason: string) => void {
  let fromA = false;
  let fromB = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone?.();
    const t = setTimeout(() => {
      a.close();
      b.close();
    }, 1_000);
    (t as { unref?(): void }).unref?.();
  };
  a.listen((f) => {
    b.post(f);
    if (f.t !== "c") return;
    fromA = true;
    if (fromB) finish();
  });
  b.listen((f) => {
    a.post(f);
    if (f.t !== "c") return;
    fromB = true;
    if (fromA) finish();
  });
  return (code, reason) => {
    if (done) return;
    a.post({ t: "c", code, reason });
    finish();
  };
}
