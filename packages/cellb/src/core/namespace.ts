import { carryWebSocketHeaders } from "../ws/upgrade.js";
import { DurableObjectId, idFromName, newUniqueId } from "./id.js";
import type { ObjectHost } from "./object-host.js";
import type { DurableObjectState } from "./state.js";

/** Structured-clone boundary: what crosses a stub is copied, as between isolates. */
const cross = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

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
          return (await obj.fetch(req)) as Response;
        }),
      call: async (method, args) => {
        const copied = cross(args);
        const r = await h.deliver((obj) => {
          const m = obj[method];
          if (typeof m !== "function")
            throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
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
  newUniqueId(_opts?: { jurisdiction?: string }): DurableObjectId {
    return newUniqueId();
  }
  idFromString(hex: string): DurableObjectId {
    return new DurableObjectId(hex);
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
  const target = {
    [kEndpoint]: endpoint,
    id,
    name: id.name,
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
  };
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop in t) return Reflect.get(t, prop, recv);
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return (...args: unknown[]) => endpoint().call(String(prop), args);
    },
  }) as DurableObjectStub;
}
