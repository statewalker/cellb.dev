import type { DurableObjectClass } from "./object-host.js";

/**
 * A class handle — what `worker.getDurableObjectClass(name)` (Worker Loader) and
 * `ctx.exports.App` return, and what `ctx.facets.get(name, () => ({ class }))` accepts.
 * Resolution may be asynchronous (loaded code is compiled on first use).
 */
export interface ClassHandle {
  readonly __cellsClassHandle: true;
  resolve(): Promise<
    { cls: DurableObjectClass; env: unknown; props?: unknown } | { isolated: IsolatedClass }
  >;
}

/** A Durable Object class that runs in an isolate: its instances and storage live there. */
export interface IsolatedClass {
  fetch(cellKey: string, req: Request): Promise<Response>;
  call(cellKey: string, method: string, args: unknown[]): Promise<unknown>;
  restart(cellKey: string): Promise<void>;
  delete(cellKey: string): Promise<void>;
  /** Tells the isolate which root epoch the facet's log is written under. */
  attach?(cellKey: string, epoch?: number): Promise<void>;
}

export function classHandle(resolve: ClassHandle["resolve"]): ClassHandle {
  return { __cellsClassHandle: true, resolve };
}

export function isClassHandle(v: unknown): v is ClassHandle {
  return (
    !!v &&
    (typeof v === "object" || typeof v === "function") &&
    (v as ClassHandle).__cellsClassHandle === true
  );
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/**
 * A stub over an asynchronously obtained target: `fetch` and JS-RPC methods, arguments
 * and results copied (structured clone) as across isolates.
 */
export function asyncStub(
  call: (method: string, args: unknown[]) => Promise<unknown>,
  fetch: (req: Request) => Promise<Response>,
): Record<string, any> {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (prop === "fetch")
          return (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(new Request(input as RequestInfo, init));
        return async (...args: unknown[]) => clone(await call(String(prop), clone(args)));
      },
    },
  );
}

/**
 * A stub of a WorkerEntrypoint (or a default export object): a fresh instance per call,
 * as workerd creates one per request; `ctx.props` carries copied startup properties.
 */
export function entrypointStub(
  target: unknown,
  env: unknown,
  props: unknown,
  exports?: unknown,
): Record<string, any> {
  const make = () => {
    if (typeof target === "function") {
      const ctx = {
        props: clone(props ?? {}),
        exports,
        waitUntil() {},
        passThroughOnException() {},
      };
      return new (target as new (c: unknown, e: unknown) => any)(ctx, env);
    }
    return target as any;
  };
  return asyncStub(
    async (method, args) => {
      const instance = make();
      const fn = instance?.[method];
      if (typeof fn !== "function")
        throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
      return fn.apply(instance, typeof target === "function" ? args : [...args]);
    },
    async (req) => {
      const instance = make();
      if (typeof instance?.fetch !== "function")
        throw new Error("Handler does not export a fetch() function.");
      return typeof target === "function"
        ? instance.fetch(req)
        : instance.fetch(req, env, {
            waitUntil() {},
            passThroughOnException() {},
            props: clone(props ?? {}),
          });
    },
  );
}
