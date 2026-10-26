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
import { cross, pipeTo, rpcPromise, STUB } from "../core/handles.js";
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
 * value runs the value's own `Symbol.dispose`, as workerd does for an `RpcTarget`. A call
 * returns an RpcPromise: calls on it go to the other side at once, naming its answer.
 */
function callsOver(port: MessageTarget, handle: Handle): Call {
  const values = new Map<number, any>();
  const answers = new Map<number, unknown>();
  let lastAnswer = 0;
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
  const send = (msg: object) => callPort(port, msg, { timeout: NO_TIMEOUT }).catch(() => {});
  const collected = new FinalizationRegistry<number>((id) => send({ type: "release", id }));
  const stubOf = (id: number) => {
    const invoke = (path: string[], args: unknown[]) => call({ type: "ref", id, path, args });
    const stub: any = new Proxy(() => {}, {
      apply: (_t, _this, args) => invoke([], args),
      get(_t, prop) {
        if (prop === STUB) return true;
        if (prop === Symbol.dispose)
          return () => {
            collected.unregister(stub);
            send({ type: "release", id });
          };
        if (prop === "then" || typeof prop === "symbol") return undefined;
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
      if (m.answer === undefined) release(m.id);
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
