import type { InputGate } from "./gates.js";
import type { DurableObjectId } from "./id.js";
import type { DurableObjectStorage } from "./storage.js";

/** `ctx` passed to a Durable Object constructor. */
export class DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  readonly #gate: InputGate;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  readonly #onBlockFailure: (e: unknown) => void;
  constructor(
    id: DurableObjectId,
    storage: DurableObjectStorage,
    gate: InputGate,
    waitUntil: (p: Promise<unknown>) => void,
    onBlockFailure: (e: unknown) => void = () => {},
  ) {
    this.#onBlockFailure = onBlockFailure;
    this.id = id;
    this.storage = storage;
    this.#gate = gate;
    this.#waitUntil = waitUntil;
  }
  /** No event is delivered to the object until `fn` settles. */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#gate.runClosed(fn);
    // A failure resets the object even when the caller (typically the
    // constructor) does not await the promise; the rejection is then observed.
    p.catch((e) => this.#onBlockFailure(e));
    return p;
  }
  waitUntil(p: Promise<unknown>): void {
    this.#waitUntil(p);
  }

  // ---- WebSocket hibernation API ------------------------------------------------
  // Sockets accepted here belong to the RUNTIME, not to the object instance: their
  // events are delivered as object events (through the input gate) to
  // webSocketMessage / webSocketClose / webSocketError on whatever instance is live.

  #dispatch?: (fn: (instance: any) => unknown) => Promise<unknown>;
  readonly #sockets = new Map<WebSocketLike, string[]>();
  #autoResponse?: { request: string; response: string };

  /** Set by the ObjectHost: delivers an event to the live instance. */
  attachDispatcher(dispatch: (fn: (instance: any) => unknown) => Promise<unknown>): void {
    this.#dispatch = dispatch;
  }

  acceptWebSocket(ws: WebSocketLike, tags: string[] = []): void {
    if (this.#sockets.has(ws)) throw new Error("WebSocket already accepted");
    if (tags.length > 10) throw new Error("A WebSocket can have at most 10 tags");
    this.#sockets.set(ws, [...tags]);
    ws.accept();
    const deliver = (fn: (o: any) => unknown) => this.#dispatch?.(fn).catch(() => {});
    ws.addEventListener("message", (e: MessageEvent) => {
      const auto = this.#autoResponse;
      if (auto && e.data === auto.request) {
        ws.send(auto.response);
        return;
      }
      void deliver((o) => o.webSocketMessage?.(ws, e.data));
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.#sockets.delete(ws);
      void deliver((o) => o.webSocketClose?.(ws, e.code, e.reason, e.wasClean));
    });
    ws.addEventListener(
      "error",
      (e: Event) => void deliver((o) => o.webSocketError?.(ws, (e as ErrorEvent).error ?? e)),
    );
  }

  getWebSockets(tag?: string): WebSocketLike[] {
    return [...this.#sockets]
      .filter(([, tags]) => tag === undefined || tags.includes(tag))
      .map(([ws]) => ws);
  }

  getTags(ws: WebSocketLike): string[] {
    const tags = this.#sockets.get(ws);
    if (!tags) throw new Error("WebSocket was not accepted with acceptWebSocket()");
    return [...tags];
  }

  setWebSocketAutoResponse(pair?: { request: string; response: string }): void {
    this.#autoResponse = pair;
  }
  getWebSocketAutoResponse(): { request: string; response: string } | null {
    return this.#autoResponse ?? null;
  }
}

/** The server end of a WebSocketPair, as seen by the hibernation API. */
export interface WebSocketLike {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (e: any) => void): void;
}
