import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import {
  callPort,
  duplexOverPort,
  getPortCloseSignal,
  listenPort,
  type MessageTarget,
  multiplexPort,
  NO_TIMEOUT,
  type PortMux,
  serveDuplexOverPort,
  structuredCodec,
} from "@statewalker/webrun-rpc";
import { cross, pipeTo, rpcPromise, STUB } from "../core/handles.js";
import { withUrl } from "../core/request-body.js";
import type { Frame } from "../ws/frames.js";
import { CellsResponse, CfWebSocket, takeClientEnd } from "../ws/server.js";
import { carryWebSocketHeaders } from "../ws/upgrade.js";

/**
 * Isolation for loaded Workers (celld runs each in its own V8 isolate): the loaded code runs
 * in a separate realm — a worker thread on Node, a Dedicated Worker in browsers — and talks
 * to the host over one MessagePort, multiplexed with `@statewalker/webrun-rpc`. The host keeps
 * everything else: bindings in the loaded Worker's env are reached through stubs, and its logs
 * come back for Tail Workers. Errors cross with their own properties (`name`, `code`, …).
 * Functions, `RpcTarget`s and stubs anywhere in a call or result cross by reference (as
 * workerd passes them): the far side gets a stub whose calls come back.
 *
 * Calls (one port, both directions; each names an `answer`, which the serving side keeps until
 * the caller has the result, so calls on it can be sent before then — promise pipelining):
 *   host → isolate   load {source|url, env, outbound}                     → loaded {exports}
 *                    call {name, method, args, props}                     → result
 *   isolate → host   log {level, args}
 *   either way       ref {id|on, path, args}  (a call on a stub of the other side's value, or
 *                                              on answer `on`: `path` is the property path
 *                                              called, [] the value itself)
 *                    release {id|answer}      (that stub was disposed or collected; the caller
 *                                              has that answer)
 * Fetches: one port per request (meta: its target and URL), HTTP/1.1 with streamed bodies,
 * as cells-http over a port (src/transport/port.ts): host → isolate to an export or facet,
 * isolate → host for the loaded code's global `fetch()` when a `globalOutbound` Fetcher routes it.
 * A WebSocket upgrade (host → isolate) has a port of its own instead, since HTTP/1.1 drops the
 * `Upgrade` header: its meta carries the request's method and headers; the isolate answers with
 * the response's head and closes the port. A 101's head carries the socket's own MessagePort,
 * transferred, and the frames the server sent before the 101 (replayed by the host's end): the
 * socket's frames then go straight between the client and the isolate, outside the multiplexer
 * and through no relay in the isolate, so open sockets hold none of its ports (it allows
 * `maxPorts` at once) and a socket's 1001 reaches its client before the isolate ends.
 */
export interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: "message", fn: (e: { data: unknown }) => void): void;
  removeEventListener?(type: "message", fn: (e: { data: unknown }) => void): void;
  on?(type: "message", fn: (data: unknown) => void): void;
  off?(type: "message", fn: (data: unknown) => void): void;
  start?(): void;
}

/** Where a fetch goes in the isolate: an export of the loaded Worker, or one of its facets. */
export type FetchTarget =
  | { name: string; props?: unknown }
  | { className: string; cellKey: string };
type Fetch = (target: FetchTarget, req: Request) => Promise<Response>;

export type Call = <T = unknown>(msg: object) => Promise<T>;
type Handle = (msg: any) => Promise<unknown>;

/**
 * The host's end of an isolate's port: one webrun-rpc multiplexer over it, a calls port on
 * which each side calls the other (`callPort`/`listenPort`, no timeout: a call lasts as long
 * as the work it starts), and a port per fetch. `outbound` serves the loaded code's global
 * `fetch()` (its `globalOutbound` Fetcher).
 */
export async function hostPort(
  port: PortLike,
  handle: Handle,
  outbound?: (req: Request) => Promise<Response>,
): Promise<{ call: Call; fetch: Fetch; close(reason: unknown): Promise<void> }> {
  const bodies = new Bodies();
  const mux = multiplexPort(messageTarget(port), {
    codec: structuredCodec,
    side: "initiator",
    maxPorts: maxPorts(),
    onPort(p, meta) {
      const m = meta as { kind?: string; url: string; id: number } | undefined;
      if (m?.kind === "body") return bodies.serve(p, m.id);
      if (m?.kind !== "outbound" || !outbound) return false;
      serveFetch(p, m.url, outbound);
      return true;
    },
  });
  const call = callsOver(await mux.openPort({ kind: "calls" }), handle, mux, bodies);
  const fetch: Fetch = (target, req) =>
    isUpgrade(req)
      ? upgradeOver(mux, { kind: "upgrade", target }, req)
      : fetchOver(mux, { kind: "fetch", target }, req);
  // Closing the multiplexer rejects every call in flight, and every later one, with `reason`.
  return { call, fetch, close: (reason) => mux.close(reason) };
}

/**
 * The isolate's end: accepts the ports the host opens. Everything the isolate calls the host
 * for happens while serving a host call, so the calls port is open by then. `outbound` sends
 * a fetch to the host's `globalOutbound`.
 */
export function isolatePort(
  port: PortLike,
  handle: Handle,
  fetch: Fetch,
): { call: Call; outbound: (req: Request) => Promise<Response> } {
  let calls: Call | undefined;
  const bodies = new Bodies();
  const mux: PortMux = multiplexPort(messageTarget(port), {
    codec: structuredCodec,
    side: "responder",
    maxPorts: maxPorts(),
    onPort(p, meta) {
      const m = meta as { kind?: string; target: FetchTarget; url: string; id: number } | undefined;
      if (m?.kind === "body") return bodies.serve(p, m.id);
      if (m?.kind === "fetch") {
        serveFetch(p, m.url, (r) => fetch(m.target, r));
        return true;
      }
      if (m?.kind === "upgrade") {
        serveUpgrade(p, m as unknown as UpgradeMeta, (r) => fetch(m.target, r));
        return true;
      }
      if (m?.kind !== "calls" || calls) return false;
      calls = callsOver(p, handle, mux, bodies);
      return true;
    },
  });
  return {
    call: (msg) => calls!(msg),
    outbound: (req) => fetchOver(mux, { kind: "outbound" }, req),
  };
}

/** A fetch over a new port of `mux`; the URL rides in the meta (the HTTP/1.1 wire drops its scheme). */
function fetchOver(mux: PortMux, meta: object, req: Request): Promise<Response> {
  return fetchOverDuplex(
    (input) =>
      (async function* () {
        yield* duplexOverPort(await mux.openPort({ ...meta, url: req.url }))(input);
      })(),
    req,
  );
}

/** Serves the fetch on port `p` (its URL from the meta) with `fetch`. */
function serveFetch(p: MessageTarget, url: string, fetch: (req: Request) => Promise<Response>) {
  serveDuplexOverPort(
    p,
    serveFetchOverDuplex((req) => withUrl(req, url).then(fetch).catch(throwOwn)),
  );
}

const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

interface UpgradeMeta {
  url: string;
  method: string;
  headers: [string, string][];
}
/**
 * Ports of an isolate's multiplexer open at once: the calls port, and one per fetch or upgrade
 * in flight (each closes when its exchange ends). `globalThis.__cellbMaxPorts` overrides it, as
 * for src/transport/port.ts.
 */
const maxPorts = () => (globalThis as { __cellbMaxPorts?: number }).__cellbMaxPorts ?? 4096;

/** The isolate's answer to an upgrade: the head of its response, or the error it threw. */
type UpgradeHead =
  | {
      status: number;
      statusText?: string;
      headers: [string, string][];
      body: ArrayBuffer | null;
      /** A 101's socket: the port of its client end, transferred. */
      socket?: MessagePort;
      /** A 101's frames that reached its client end before the hand-over. */
      frames?: Frame[];
    }
  | { error: unknown };

/** Statuses whose response has no body (`new Response(body, …)` refuses one). */
const nullBody = (status: number) => [101, 204, 205, 304].includes(status);

/**
 * A WebSocket upgrade over a port of its own, closed once the isolate's answer is in. A 101
 * becomes a Workers response whose `webSocket` is a client end over the socket's own port.
 */
async function upgradeOver(mux: PortMux, meta: object, req: Request): Promise<Response> {
  const p = await mux.openPort({
    ...meta,
    url: req.url,
    method: req.method,
    headers: [...req.headers],
  } satisfies UpgradeMeta);
  return new Promise((resolve, reject) => {
    // A port closed without an answer (the isolate refused it, or could not post one)
    // fails the upgrade rather than leaving it pending.
    const closed = getPortCloseSignal(p);
    const onClosed = () => {
      p.removeEventListener("message", onHead);
      reject(
        closed?.reason ?? new Error("cellb: the isolate closed the upgrade without an answer"),
      );
    };
    closed?.addEventListener("abort", onClosed, { once: true });
    const onHead = (e: MessageEvent) => {
      p.removeEventListener("message", onHead);
      closed?.removeEventListener("abort", onClosed);
      void p.close?.();
      try {
        const head = e.data as UpgradeHead;
        if ("error" in head) throw head.error;
        if (head.status === 101 && head.socket)
          return resolve(
            new CellsResponse(null, {
              status: 101,
              headers: head.headers,
              webSocket: new CfWebSocket(head.socket, head.frames),
            }),
          );
        resolve(
          new Response(nullBody(head.status) ? null : head.body, {
            status: head.status,
            statusText: head.statusText,
            headers: head.headers,
          }),
        );
      } catch (err) {
        reject(err);
      }
    };
    p.addEventListener("message", onHead);
    void p.start?.();
  });
}

/** Serves an upgrade on port `p`: a 101 hands over its client end's port; then `p` closes. */
function serveUpgrade(
  p: MessageTarget,
  meta: UpgradeMeta,
  fetch: (req: Request) => Promise<Response>,
) {
  // A browser drops `Upgrade` and `Sec-WebSocket-*` from `new Request()`: carried over here.
  const headers = new Headers(meta.headers);
  const req = carryWebSocketHeaders(
    headers,
    new Request(meta.url, { method: meta.method, headers }),
  );
  const answer = (head: UpgradeHead, transfer: Transferable[] = []) => {
    try {
      // The multiplexer drops a message it cannot copy, so check before posting; a 101
      // head is not checked, since its socket port is transferred rather than copied.
      if (transfer.length === 0) cloneable(head);
      p.postMessage(head, transfer);
    } catch {
      // An error that cannot be copied (a function in its `cause`, say): its name and message.
      const e = (head as { error?: { name?: unknown; message?: unknown } }).error;
      p.postMessage({
        error: Object.assign(new Error(String(e?.message ?? e)), {
          name: String(e?.name ?? "Error"),
        }),
      } satisfies UpgradeHead);
    }
  };
  void (async () => {
    try {
      const res = await fetch(req);
      const ws = (res as { webSocket?: CfWebSocket | null }).webSocket;
      if (res.status === 101 && ws) {
        const { port: socket, frames } = takeClientEnd(ws);
        answer({ status: 101, headers: [...res.headers], body: null, socket, frames }, [socket]);
      } else
        answer({
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers],
          body: nullBody(res.status) ? null : await res.arrayBuffer(),
        });
    } catch (error) {
      answer({ error });
    }
    void p.close?.();
  })();
}

/** Marks a Request, Response, Headers or ReadableStream in a message: `{ [WIRE]: kind, … }`. */
const WIRE = "\u0000cellb.wire";

// The realm's own classes, before the isolate entry replaces the globals with its subclasses
// (CellsRequest, CellsResponse): instances of either are instances of these.
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeHeaders = globalThis.Headers;
const NativeReadableStream = globalThis.ReadableStream;

/**
 * The bodies one side has sent and the other has not read yet, by id. The reader opens a port
 * `{ kind: "body", id }` on the multiplexer when it first pulls, and the body streams over it,
 * as a fetch's body does; a reader that drops the body unread sends `release {body}` instead.
 */
class Bodies {
  #last = 0;
  #streams = new Map<number, ReadableStream>();
  add(stream: ReadableStream): number {
    this.#streams.set(++this.#last, stream);
    return this.#last;
  }
  /** The last id handed out, for `releaseSince`. */
  mark(): number {
    return this.#last;
  }
  /** Releases the bodies added after `mark` (a message that could not be sent). */
  releaseSince(mark: number): void {
    for (let id = mark + 1; id <= this.#last; id++) this.release(id);
  }
  release(id: number): void {
    const stream = this.#streams.get(id);
    this.#streams.delete(id);
    void stream?.cancel().catch(() => {});
  }
  /** Serves body `id` on port `p`; false (the port is refused) if there is no such body. */
  serve(p: MessageTarget, id: number): boolean {
    const stream = this.#streams.get(id);
    if (!stream) return false;
    this.#streams.delete(id);
    const encoder = new TextEncoder();
    serveDuplexOverPort(p, async function* () {
      // A reader, not `for await`: not every engine iterates a ReadableStream (Safari).
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) return;
          yield typeof chunk === "string"
            ? encoder.encode(chunk)
            : ArrayBuffer.isView(chunk)
              ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : new Uint8Array(chunk as ArrayBuffer);
        }
      } finally {
        // The reader stopped early (the port was abandoned): the stream is cancelled.
        void reader.cancel().catch(() => {});
      }
    });
    return true;
  }
}

/**
 * A Request, Response, Headers or ReadableStream as a message can carry it (workerd's RPC passes
 * them; a port cannot clone them): its head copied, its body registered in `bodies` to stream
 * when read. Anything else is returned as it is.
 */
function toWire(v: unknown, bodies: Bodies): unknown {
  if (v instanceof NativeHeaders) return { [WIRE]: "headers", entries: [...v] };
  if (v instanceof NativeReadableStream) return { [WIRE]: "stream", body: bodies.add(v) };
  if (v instanceof NativeResponse) {
    if ((v as { webSocket?: unknown }).webSocket)
      throw new DOMException(
        "A WebSocket response cannot be passed in an RPC call; return it from fetch().",
        "DataCloneError",
      );
    return {
      [WIRE]: "response",
      status: v.status,
      statusText: v.statusText,
      url: v.url,
      headers: [...v.headers],
      body: v.body ? bodies.add(v.body) : null,
    };
  }
  if (v instanceof NativeRequest)
    return {
      [WIRE]: "request",
      url: v.url,
      method: v.method,
      headers: [...v.headers],
      redirect: v.redirect,
      body: v.body ? bodies.add(v.body) : null,
    };
  return v;
}

/** Releases a body that was never read, once its stream is collected. */
const unread = new FinalizationRegistry<() => void>((release) => release());

/**
 * The other side's body `id` as a stream: the first pull opens its port, so a body nobody
 * reads costs nothing but its release.
 */
function remoteBody(mux: PortMux, id: number, release: (id: number) => void): ReadableStream {
  let chunks: AsyncIterator<Uint8Array> | undefined;
  const token = {};
  const stream = new NativeReadableStream<Uint8Array>({
    async pull(controller) {
      if (!chunks) {
        unread.unregister(token);
        const port = await mux.openPort({ kind: "body", id });
        chunks = duplexOverPort(port)([])[Symbol.asyncIterator]();
      }
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (chunks) await chunks.return?.(reason);
      else {
        unread.unregister(token);
        release(id);
      }
    },
  });
  unread.register(stream, () => release(id), token);
  return stream;
}

/** Statuses whose Response has no body. */
const NULL_BODY = [101, 103, 204, 205, 304];

/** The value `toWire` described, rebuilt; its body streams from the other side when read. */
function fromWire(v: any, mux: PortMux, release: (id: number) => void): unknown {
  const body = (id: number | null) => (id === null ? null : remoteBody(mux, id, release));
  switch (v[WIRE]) {
    case "headers":
      return new Headers(v.entries);
    case "stream":
      return body(v.body);
    case "response": {
      if (NULL_BODY.includes(v.status) && v.body !== null) release(v.body);
      const res = new Response(NULL_BODY.includes(v.status) ? null : body(v.body), {
        status: v.status,
        statusText: v.statusText,
        headers: v.headers,
      });
      if (v.url) Object.defineProperty(res, "url", { value: v.url, enumerable: true });
      return res;
    }
    case "request":
      return new Request(v.url, {
        method: v.method,
        headers: v.headers,
        redirect: v.redirect,
        body: body(v.body),
        duplex: "half",
      } as RequestInit);
  }
  return v;
}

/** Marks a value passed by reference in a message: `{ [REF]: id }`. */
const REF = "\u0000cellb.ref";

/**
 * The calls of one port, with values passed by reference: each side keeps the values it
 * passed (by id, and how many ids hold each); the other side calls them through stubs. A
 * stub's `Symbol.dispose` (or its garbage collection) releases its id; the last release of a
 * value runs the value's own `Symbol.dispose`, as workerd does for an `RpcTarget`. A call
 * returns an RpcPromise: calls on it go to the other side at once, naming its answer.
 */
function callsOver(port: MessageTarget, handle: Handle, mux: PortMux, bodies: Bodies): Call {
  const values = new Map<number, any>();
  const answers = new Map<number, unknown>();
  let lastAnswer = 0;
  const holders = new Map<unknown, number>();
  let lastId = 0;
  const encode = (v: unknown) => {
    const mark = bodies.mark();
    try {
      return cloneable(
        cross(
          v,
          (x) => {
            values.set(++lastId, x);
            holders.set(x, (holders.get(x) ?? 0) + 1);
            return { [REF]: lastId };
          },
          (x) => toWire(x, bodies), // Requests, Responses, Headers, streams; the port copies the rest
        ),
      );
    } catch (e) {
      bodies.releaseSince(mark); // the message is not sent: nobody will read its bodies
      throw e;
    }
  };
  const release = (id: number) => {
    const v = values.get(id);
    if (!values.delete(id)) return;
    const n = (holders.get(v) ?? 1) - 1;
    if (n) holders.set(v, n);
    else {
      holders.delete(v);
      v[Symbol.dispose]?.();
    }
  };
  const send = (msg: object) => callPort(port, msg, { timeout: NO_TIMEOUT }).catch(() => {});
  // Stubs of one id held here: `dup()` makes another, and the id is released (and the other
  // side's value with it, once no other id holds it) when the last of them is disposed or
  // collected.
  const local = new Map<number, number>();
  const drop = (id: number) => {
    const n = (local.get(id) ?? 1) - 1;
    if (n) local.set(id, n);
    else {
      local.delete(id);
      send({ type: "release", id });
    }
  };
  const collected = new FinalizationRegistry<number>(drop);
  const stubOf = (id: number) => {
    local.set(id, (local.get(id) ?? 0) + 1);
    let disposed = false;
    const live = () => {
      if (disposed) throw new Error("A stub was used after it was disposed.");
    };
    const invoke = (path: string[], args: unknown[]) => {
      live();
      return call({ type: "ref", id, path, args });
    };
    const stub: any = new Proxy(() => {}, {
      apply: (_t, _this, args) => invoke([], args),
      get(_t, prop) {
        if (prop === STUB) return true;
        if (prop === Symbol.dispose)
          return () => {
            if (disposed) return;
            disposed = true;
            collected.unregister(stub);
            drop(id);
          };
        if (prop === "then" || typeof prop === "symbol") return undefined;
        // workerd's `stub.dup()`: another stub of the same value, disposed on its own.
        if (prop === "dup")
          return () => {
            live();
            return stubOf(id);
          };
        return (...args: unknown[]) => invoke([prop], args);
      },
    });
    collected.register(stub, id, stub);
    return stub;
  };
  // Messages arrive as fresh copies: stubs replace the markers in place.
  const decode = (v: any): any => {
    if (Array.isArray(v)) for (let i = 0; i < v.length; i++) v[i] = decode(v[i]);
    else if (v && Object.getPrototypeOf(v) === Object.prototype) {
      if (typeof v[WIRE] === "string")
        return fromWire(v, mux, (body) => send({ type: "release", body }));
      if (typeof v[REF] === "number") return stubOf(v[REF]);
      for (const k of Object.keys(v)) v[k] = decode(v[k]);
    }
    return v;
  };
  const run = (m: any): unknown => {
    if (m.type !== "ref") return handle(m);
    if (m.on !== undefined) return pipeTo(answers.get(m.on), m.path, m.args);
    const v = values.get(m.id);
    if (v === undefined) throw new Error("A stub was used after it was disposed.");
    return pipeTo(v, m.path, m.args);
  };
  // The answer is kept as the message arrives: a pipelined call on it may arrive before it
  // settles.
  const serve = async (m: any) => {
    if (m.type === "release") {
      if (m.body !== undefined) bodies.release(m.body);
      else if (m.answer === undefined) release(m.id);
      else answers.delete(m.answer);
      return;
    }
    let r: unknown;
    try {
      r = run(m);
    } catch (e) {
      r = Promise.reject(e);
    }
    answers.set(m.answer, r);
    return r;
  };
  listenPort(port, (msg) => serve(decode(msg)).then(encode).catch(throwOwn));
  const call: Call = (msg) => {
    const answer = ++lastAnswer;
    const result = (async () =>
      decode(await callPort(port, encode({ ...msg, answer }), { timeout: NO_TIMEOUT })))();
    // Calls on the answer sent before now are ahead of this release on the port.
    const done = () => send({ type: "release", answer });
    result.then(done, done);
    return rpcPromise(result, (path, args) => call({ type: "ref", on: answer, path, args }));
  };
  return call;
}

/** Errors cross with their own properties (so `code` does); `name` is inherited, so copy it. */
function throwOwn(e: unknown): never {
  if (e && typeof e === "object")
    Object.defineProperty(e, "name", { value: (e as Error).name, enumerable: true });
  throw e;
}

/**
 * Throws `DataCloneError` for a value the port cannot carry: the multiplexer drops a message
 * it fails to post, and the call would wait forever.
 */
function cloneable<T>(value: T): T {
  structuredClone(value);
  return value;
}

/** A worker_threads Worker is an EventEmitter; MessagePorts and Dedicated Workers are targets. */
function messageTarget(port: PortLike): MessageTarget {
  if (port.addEventListener) return port as MessageTarget;
  const on = port.on!.bind(port);
  const listeners = new Map<unknown, (data: unknown) => void>();
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, transfer),
    addEventListener(_type, fn) {
      const listener = (data: unknown) => void fn({ data } as MessageEvent);
      listeners.set(fn, listener);
      on("message", listener);
    },
    removeEventListener(_type, fn) {
      port.off?.("message", listeners.get(fn)!);
      listeners.delete(fn);
    },
  };
}
