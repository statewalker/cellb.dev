/** Wire protocol of a WebSocket carried by a MessagePort (both directions). */
export type Frame =
  | { t: "m"; d: string | ArrayBuffer } // message
  | { t: "c"; code: number; reason: string } // close (initiating or echo)
  | { t: "p"; hb: number } // ping (client → server), carries the heartbeat period
  | { t: "q" }; // pong (server → client)

/**
 * MessagePorts never report that the other side died (no `close` event in
 * browsers), so both ends run a heartbeat: the client pings every `hb` ms and
 * closes with 1006 when pongs stop for 2·hb; the server closes with 1006 when
 * pings stop for 3·hb. This is what makes a socket notice a closed tab.
 */
export const DEFAULT_HEARTBEAT_MS = 10_000;

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
