import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import {
  callPort,
  duplexOverPort,
  listenPort,
  type MessageTarget,
  multiplexPort,
  NO_TIMEOUT,
  serveDuplexOverPort,
  structuredCodec,
} from "@statewalker/webrun-rpc";
import { cross, STUB } from "../core/handles.js";
import { withUrl } from "../core/request-body.js";

/**
 * Isolation for loaded Workers (celld runs each in its own V8 isolate): the loaded code runs
 * in a separate realm — a worker thread on Node, a Dedicated Worker in browsers — and talks
 * to the host over one MessagePort, multiplexed with `@statewalker/webrun-rpc`. The host keeps
 * everything else: bindings in the loaded Worker's env are reached through stubs, and its logs
 * come back for Tail Workers. Errors cross with their own properties (`name`, `code`, …).
 * Functions, `RpcTarget`s and stubs anywhere in a call or result cross by reference (as
 * workerd passes them): the far side gets a stub whose calls come back.
 *
 * Calls (one port, both directions):
 *   host → isolate   load {source|url, env, outbound}                     → loaded {exports}
 *                    call {name, method, args, props}                     → result
 *   isolate → host   log {level, args}
 *   either way       ref {id, method?, args}  (a call on a stub of the other side's value)
 *                    release {id}             (that stub was disposed or collected)
 * Fetches: one port per request (meta: its target and URL), HTTP/1.1 with streamed bodies,
 * as cells-http over a port (src/transport/port.ts).
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
 * as the work it starts), and a port per fetch.
 */
export async function hostPort(
  port: PortLike,
  handle: Handle,
): Promise<{ call: Call; fetch: Fetch }> {
  const mux = multiplexPort(messageTarget(port), { codec: structuredCodec, side: "initiator" });
  const call = callsOver(await mux.openPort({ kind: "calls" }), handle);
  const fetch: Fetch = (target, req) =>
    fetchOverDuplex(
      (input) =>
        (async function* () {
          // The URL rides in the meta: the HTTP/1.1 wire drops its scheme.
          yield* duplexOverPort(await mux.openPort({ kind: "fetch", target, url: req.url }))(input);
        })(),
      req,
    );
  return { call, fetch };
}

/**
 * The isolate's end: accepts the ports the host opens. Everything the isolate calls the host
 * for happens while serving a host call, so the calls port is open by then.
 */
export function isolatePort(port: PortLike, handle: Handle, fetch: Fetch): { call: Call } {
  let calls: Call | undefined;
  multiplexPort(messageTarget(port), {
    codec: structuredCodec,
    side: "responder",
    onPort(p, meta) {
      const m = meta as { kind?: string; target: FetchTarget; url: string } | undefined;
      if (m?.kind === "fetch") {
        serveDuplexOverPort(
          p,
          serveFetchOverDuplex((req) =>
            withUrl(req, m.url)
              .then((r) => fetch(m.target, r))
              .catch(throwOwn),
          ),
        );
        return true;
      }
      if (m?.kind !== "calls" || calls) return false;
      calls = callsOver(p, handle);
      return true;
    },
  });
  return { call: (msg) => calls!(msg) };
}

/** Marks a value passed by reference in a message: `{ [REF]: id }`. */
const REF = "\u0000cellb.ref";

/**
 * The calls of one port, with values passed by reference: each side keeps the values it
 * passed (by id, and how many ids hold each); the other side calls them through stubs. A
 * stub's `Symbol.dispose` (or its garbage collection) releases its id; the last release of a
 * value runs the value's own `Symbol.dispose`, as workerd does for an `RpcTarget`.
 */
function callsOver(port: MessageTarget, handle: Handle): Call {
  const values = new Map<number, any>();
  const holders = new Map<unknown, number>();
  let lastId = 0;
  const encode = (v: unknown) =>
    cloneable(
      cross(
        v,
        (x) => {
          values.set(++lastId, x);
          holders.set(x, (holders.get(x) ?? 0) + 1);
          return { [REF]: lastId };
        },
        (x) => x, // the port copies the rest
      ),
    );
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
  const collected = new FinalizationRegistry<number>((id) => {
    call({ type: "release", id }).catch(() => {});
  });
  const stubOf = (id: number) => {
    const invoke = (method: string | undefined, args: unknown[]) =>
      call({ type: "ref", id, method, args });
    const stub: any = new Proxy(() => {}, {
      apply: (_t, _this, args) => invoke(undefined, args),
      get(_t, prop) {
        if (prop === STUB) return true;
        if (prop === Symbol.dispose)
          return () => {
            collected.unregister(stub);
            call({ type: "release", id }).catch(() => {});
          };
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return (...args: unknown[]) => invoke(prop, args);
      },
    });
    collected.register(stub, id, stub);
    return stub;
  };
  // Messages arrive as fresh copies: stubs replace the markers in place.
  const decode = (v: any): any => {
    if (Array.isArray(v)) for (let i = 0; i < v.length; i++) v[i] = decode(v[i]);
    else if (v && Object.getPrototypeOf(v) === Object.prototype) {
      if (typeof v[REF] === "number") return stubOf(v[REF]);
      for (const k of Object.keys(v)) v[k] = decode(v[k]);
    }
    return v;
  };
  const serve = async (m: any) => {
    if (m.type === "release") return release(m.id);
    if (m.type !== "ref") return handle(m);
    const v = values.get(m.id);
    if (v === undefined) throw new Error("A stub was used after it was disposed.");
    return m.method === undefined ? v(...m.args) : v[m.method](...m.args);
  };
  listenPort(port, (msg) => serve(decode(msg)).then(encode).catch(throwOwn));
  const call: Call = async (msg) =>
    decode(await callPort(port, encode(msg), { timeout: NO_TIMEOUT }));
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
