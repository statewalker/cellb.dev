// The reference server two of the examples talk to (`workflow` fetches /text/<n>, `wsclient` opens
// a WebSocket to /room/<name>), answered inside this worker: the conformance runs start a real
// one (packages/cellb/test/ws-reference-server.ts), a static site has none. It replaces `fetch`
// and `WebSocket` for the host `reference.invalid` only, and must be imported before cellb, which
// keeps the realm's WebSocket class when it loads.
export const REFERENCE_SERVER = "ws://reference.invalid";
const HOST = "reference.invalid";

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host !== HOST) return realFetch(input, init);
  const m = /^\/text\/(\d+)$/.exec(url.pathname);
  if (!m) return new Response(null, { status: 404 });
  const text = Array.from({ length: Number(m[1]) }, (_, i) => `line ${i + 1}`).join("\n");
  return new Response(text, { headers: { "content-type": "text/plain" } });
}) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;
const rooms = new Map<string, Set<ReferenceSocket>>();

/** The reference server's room protocol: each text message goes to every socket in the room. */
class ReferenceSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  #room = new Set<ReferenceSocket>();

  constructor(
    readonly url: string,
    protocols?: string | string[],
  ) {
    super();
    const u = new URL(url);
    // Any other host: the realm's own WebSocket (one class has to stand for both).
    // biome-ignore lint/correctness/noConstructorReturn: the real socket replaces this one
    if (u.host !== HOST) return new RealWebSocket(url, protocols) as unknown as ReferenceSocket;
    const name = /^\/room\/([\w-]+)$/.exec(u.pathname)?.[1] ?? "";
    this.#room = rooms.get(name) ?? new Set();
    rooms.set(name, this.#room);
    setTimeout(() => {
      if (!name) return this.#closed(1006, "");
      this.#room.add(this);
      this.readyState = 1;
      this.#emit(new Event("open"));
    });
  }

  send(data: string) {
    if (this.readyState !== 1) throw new DOMException("not open", "InvalidStateError");
    for (const s of this.#room)
      setTimeout(() => s.readyState === 1 && s.#emit(new MessageEvent("message", { data })));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this.#closed(code, reason));
  }

  #closed(code: number, reason: string) {
    this.#room?.delete(this);
    this.readyState = 3;
    this.#emit(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
  }

  #emit(e: Event) {
    this.dispatchEvent(e);
    const handler = (this as unknown as Record<string, unknown>)[`on${e.type}`];
    if (typeof handler === "function") handler.call(this, e);
  }
}

globalThis.WebSocket = ReferenceSocket as unknown as typeof WebSocket;
