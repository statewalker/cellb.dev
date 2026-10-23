import { carryWebSocketHeaders } from "../ws/upgrade.js";
import { RpcTarget } from "./durable-object.js";
import { type DurableObjectId, idFromName, newUniqueId, validateId } from "./id.js";
import type { ObjectHost } from "./object-host.js";
import type { DurableObjectState } from "./state.js";

/** Structured-clone boundary: what crosses a stub is copied, as between isolates. */
/**
 * What crosses a stub call, as celld does in one isolate: values are structured-cloned,
 * functions pass by reference, and an RpcTarget is refused ("cannot cross isolate
 * boundaries yet" — celld has no RPC stubs across isolates).
 */
const cross = <T>(v: T): T => {
  if (v === undefined || v === null) return v;
  if (typeof v === "function") return v;
  if (v instanceof RpcTarget) throw new Error("RPC stubs cannot cross isolate boundaries yet.");
  if (Array.isArray(v)) return v.map(cross) as T;
  if (Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cross(x);
    return out as T;
  }
  return structuredClone(v);
};

/** What a stub talks to: a local ObjectHost or a remote cell host behind a port. */
export interface ObjectEndpoint {
  fetch(req: Request): Promise<Response>;
  call(method: string, args: unknown[]): Promise<unknown>;
  /** Present only for in-process objects (enables runInDurableObject). */
  local?: ObjectHost;
}

export function localEndpoint(host: () => ObjectHost): () => ObjectEndpoint {
  return () => {
    const h = host();
    return {
      local: h,
      fetch: (req) =>
        h.deliver(async (obj) => {
          if (typeof obj.fetch !== "function")
            throw new Error("Handler does not export a fetch() function.");
          let res: Response;
          try {
            const r = await obj.fetch(req);
            res = r instanceof Response ? r : new Response(String(r)); // a non-Response is sent as text (celld)
          } catch (e) {
            // celld: the stub's fetch() rejects with "rejected: <name>: <message> [at …]".
            const err = e as Error;
            throw new Error(`rejected: ${err?.name ?? "Error"}: ${err?.message ?? String(e)}`, {
              cause: e,
            });
          }
          // A WebSocket answer to a request that did not ask for one fails (workerd, celld):
          // the stub rejects and the server end sees an abnormal close.
          const ws = (res as { webSocket?: unknown }).webSocket;
          if (res.status === 101 && ws && req.headers.get("upgrade")?.toLowerCase() !== "websocket")
            throw new Error(
              "rejected: Error: a WebSocket response to a request without Upgrade: websocket",
            );
          return res;
        }),
      call: async (method, args) => {
        const copied = cross(args);
        const r = await h.deliver((obj) => {
          const m = obj[method];
          if (typeof m !== "function") throw new TypeError(`${method} is not a function`); // celld's wording
          return m.apply(obj, copied);
        });
        return cross(r);
      },
    };
  };
}

export class DurableObjectNamespace {
  readonly #key: string;
  readonly #endpoint: (id: DurableObjectId) => () => ObjectEndpoint;

  constructor(namespaceKey: string, endpoint: (id: DurableObjectId) => () => ObjectEndpoint) {
    this.#key = namespaceKey;
    this.#endpoint = endpoint;
  }
  idFromName(name: string): DurableObjectId {
    return idFromName(this.#key, name);
  }
  newUniqueId(opts?: { jurisdiction?: string }): DurableObjectId {
    if (opts?.jurisdiction != null)
      throw new Error("Jurisdiction restrictions are not implemented");
    return newUniqueId(this.#key);
  }
  idFromString(hex: string): DurableObjectId {
    return validateId(this.#key, hex);
  }
  /** The key ids of this namespace derive from (see id.ts). */
  get namespaceKey(): string {
    return this.#key;
  }
  get(id: DurableObjectId): DurableObjectStub {
    return createStub(id, this.#endpoint(id));
  }
  getByName(name: string): DurableObjectStub {
    return this.get(this.idFromName(name));
  }
}

export type DurableObjectStub = {
  readonly id: DurableObjectId;
  readonly name?: string;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} & Record<string, any>;

const kEndpoint = Symbol("webrun-cells.endpoint");

/**
 * Test hook (same idea as vitest-pool-workers' runInDurableObject): runs `fn`
 * inside a LOCAL object, through the input/output gates, without cloning `fn`.
 */
export function runInDurableObject<T>(
  stub: DurableObjectStub,
  fn: (instance: any, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  const ep = (stub as any)[kEndpoint] as (() => ObjectEndpoint) | undefined;
  const local = ep?.().local;
  if (!local)
    throw new TypeError("runInDurableObject needs a stub of an in-process webrun-cells object");
  return local.deliver(fn);
}

/** Stub = Proxy: `fetch` → fetch handler, any other property → JS-RPC call. */
function createStub(id: DurableObjectId, endpoint: () => ObjectEndpoint): DurableObjectStub {
  const target = { id, name: id.name };
  // Only id and name are own enumerable keys, as in workerd and celld: Object.keys(stub) is
  // [id, name], and two stubs of one object are deep-equal.
  Object.defineProperty(target, kEndpoint, { value: endpoint });
  Object.defineProperty(target, "fetch", {
    value(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = new Request(input as any, init);
      // Cloudflare's `cf` request property (RequestInit.cf or Request#cf) is not part of
      // the Fetch standard: re-attach it so objects can read `request.cf`.
      const cf = (init as { cf?: unknown } | undefined)?.cf ?? (input as { cf?: unknown }).cf;
      if (cf !== undefined) Object.defineProperty(req, "cf", { value: cf, enumerable: true });
      // Keep a WebSocket upgrade that browsers strip from new Request() (forbidden headers).
      const source = init?.headers
        ? new Headers(init.headers)
        : input instanceof Request
          ? input.headers
          : undefined;
      return endpoint().fetch(source ? carryWebSocketHeaders(source, req) : req);
    },
  });
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop in t) return Reflect.get(t, prop, recv);
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return (...args: unknown[]) => endpoint().call(String(prop), args);
    },
  }) as unknown as DurableObjectStub;
}
