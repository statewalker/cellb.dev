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

/**
 * Isolation for loaded Workers (celld runs each in its own V8 isolate): the loaded code runs
 * in a separate realm — a worker thread on Node, a Dedicated Worker in browsers — and talks
 * to the host over one MessagePort, multiplexed with `@statewalker/webrun-rpc`. The host keeps
 * everything else: bindings in the loaded Worker's env are reached through stubs, and its logs
 * come back for Tail Workers. Errors cross with their own properties (`name`, `code`, …).
 *
 * Calls (one port, both directions):
 *   host → isolate   load {source|url, plain env, stub names, outbound}   → loaded {exports}
 *                    call {name, method, args, props}                     → result
 *   isolate → host   stub {key, method, args}                             → result
 *                    log {level, args}
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

function callsOver(port: MessageTarget, handle: Handle): Call {
  listenPort(port, (msg) => handle(msg).then(cloneable).catch(throwOwn));
  return async (msg) => callPort(port, cloneable(msg), { timeout: NO_TIMEOUT });
}

/** Errors cross with their own properties (so `code` does); `name` is inherited, so copy it. */
function throwOwn(e: unknown): never {
  if (e && typeof e === "object")
    Object.defineProperty(e, "name", { value: (e as Error).name, enumerable: true });
  throw e;
}

/**
 * The request under its original URL. Firefox has no `Request.body` (and `new Request(url, req)`
 * reads that same property), so there the body, already buffered by serveFetchOverDuplex, is
 * read whole.
 */
const withUrl = async (req: Request, url: string) =>
  req.url === url
    ? req
    : new Request(url, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? (req.method === "GET" || req.method === "HEAD" ? null : await req.blob()),
        duplex: "half",
      } as RequestInit);

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

/** Plain (structured-cloneable) env values travel; anything else becomes a stub by key. */
export function splitEnv(env: Record<string, unknown>): {
  plain: Record<string, unknown>;
  stubs: string[];
} {
  const plain: Record<string, unknown> = {};
  const stubs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    try {
      if (typeof v === "function") throw new Error("function");
      plain[k] = structuredClone(v);
    } catch {
      stubs.push(k);
    }
  }
  return { plain, stubs };
}
