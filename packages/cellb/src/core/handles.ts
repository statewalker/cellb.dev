import { deserialize, type HostObjects, serialize } from "../v8/serialize.js";
import { isRpcTarget, isWorkerEntrypoint } from "./durable-object.js";
import type { DurableObjectState } from "./state.js";

export type DurableObjectClass = new (ctx: DurableObjectState, env: any) => any;

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

/** Key of the isolate's class factory on a module facade (see getDurableObjectClass). */
export const ISOLATED = Symbol.for("cellb.isolated-classes");

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

/** Answered `true` by cellb's stubs: they cross by reference. */
export const STUB = Symbol.for("cellb.stub");
/** Answered by a value that may not cross, with workerd's reason. */
export const REFUSE = Symbol.for("cellb.refuse");
/** Answered by a `ctx.exports.X({ props })` stub or class handle: `{ name, props }` (storable). */
export const EXPORT = Symbol.for("cellb.export");

/**
 * What crosses a stub, as in workerd: functions, `RpcTarget`s, stubs and class handles by
 * reference (`ref` says what stands for one on the far side; in one realm, the value itself),
 * arrays and plain objects walked, anything else structured-cloned (`copy`).
 */
export function cross<T>(
  v: T,
  ref: (v: object) => unknown = (x) => x,
  copy: (v: unknown) => unknown = structuredClone,
): T {
  if (v === undefined || v === null || (typeof v !== "object" && typeof v !== "function"))
    return copy(v) as T;
  const refused = (v as Record<symbol, unknown>)[REFUSE];
  if (typeof refused === "string") throw new DOMException(refused, "DataCloneError");
  if (
    typeof v === "function" ||
    isRpcTarget(v) ||
    (v as Record<symbol, unknown>)[STUB] === true ||
    isClassHandle(v)
  )
    return ref(v) as T;
  if (Array.isArray(v)) return v.map((x) => cross(x, ref, copy)) as T;
  if (Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cross(x, ref, copy);
    return out as T;
  }
  return copy(v) as T;
}

/**
 * A value sent to an object on another node (cells-http, celld's tunnel), checked first: only
 * copies travel between nodes, so a function, `RpcTarget` or stub is refused, not sent as `{}`.
 */
export function toAnotherNode<T>(v: T): T {
  cross(
    v,
    () => {
      const e = new DOMException(
        "Functions, RpcTargets and stubs cannot be sent to another node: they pass by reference only within one runtime.",
        "DataCloneError",
      );
      // An own `name`, so it survives the error's trip back over the link.
      throw Object.defineProperty(e, "name", { value: e.name, enumerable: true });
    },
    (x) => x,
  );
  return v;
}

/** Where a call on an RpcPromise goes: the property path from its result, and the arguments. */
export type Pipe = (path: string[], args: unknown[]) => unknown;

const RPC_PROMISE = Symbol("cellb.rpc-promise");

/**
 * workerd's RpcPromise: what a call on a stub returns. It is awaited as a promise, and used
 * before it settles (promise pipelining): a property read gives the RpcPromise of that path,
 * and a call on a path goes through `pipe` at once, without waiting for `result`.
 */
export function rpcPromise(result: Promise<unknown>, pipe: Pipe): any {
  const at = (path: string[]): any => {
    let value: Promise<unknown> | undefined;
    // The result itself is a Promise-like object, not callable (node:assert calls a function
    // given to `rejects`); a property path is callable.
    return new Proxy(path.length ? () => {} : Object.create(Promise.prototype), {
      apply: (_t, _this, args) => rpcCall(() => pipe(path, args)),
      get(_t, prop) {
        if (prop === RPC_PROMISE) return true;
        if (prop === "then" || prop === "catch" || prop === "finally") {
          value ??= result.then((v) => path.reduce((o: any, k) => o[k], v));
          return value[prop].bind(value);
        }
        if (typeof prop === "symbol") return undefined;
        return at([...path, prop]);
      },
    });
  };
  return at([]);
}

/**
 * Runs a call and returns its result as an RpcPromise (`map` applies to the settled value);
 * calls on it go to the result: at once if the result is an RpcPromise itself, else once it
 * settles.
 */
export function rpcCall(call: () => unknown, map?: (v: unknown) => unknown): any {
  let r: unknown;
  try {
    r = call();
  } catch (e) {
    r = Promise.reject(e);
  }
  const result = Promise.resolve(r);
  return rpcPromise(map ? result.then(map) : result, (path, args) => pipeTo(r, path, args));
}

/** Calls `path` of `r` (a value, a promise of one, or an RpcPromise) with `args`. */
export function pipeTo(r: unknown, path: string[], args: unknown[]): unknown {
  const callAt = (v: any) => {
    if (!path.length) return v(...args);
    const receiver = path.slice(0, -1).reduce((o, k) => o[k], v);
    return receiver[path[path.length - 1]](...args);
  };
  return (r as Record<symbol, unknown>)?.[RPC_PROMISE]
    ? callAt(r)
    : Promise.resolve(r).then(callAt);
}

/**
 * A stub over an asynchronously obtained target: `fetch` and JS-RPC methods, arguments
 * and results crossing as between isolates. A method's result is an RpcPromise over what
 * `call` returns.
 */
export function asyncStub(
  call: (method: string, args: unknown[]) => unknown,
  fetch: (req: Request) => Promise<Response>,
): Record<string, any> {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === STUB) return true;
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (prop === "fetch")
          return (input: RequestInfo | URL, init?: RequestInit) =>
            fetch(new Request(input as RequestInfo, init));
        return (...args: unknown[]) => rpcCall(() => call(String(prop), cross(args)), cross);
      },
    },
  );
}

/**
 * A stub of a WorkerEntrypoint (or a default export object): a fresh instance per call,
 * as workerd creates one per request; `ctx.props` carries copied startup properties. Methods
 * of a plain object receive `(…args, env, ctx)`, as its `fetch` receives `(request, env, ctx)`.
 */
export function entrypointStub(
  target: unknown,
  env: unknown,
  props: unknown,
  exports?: unknown,
): Record<string, any> {
  const objectCtx = () => ({
    waitUntil() {},
    passThroughOnException() {},
    props: cross(props ?? {}),
  });
  const make = () => {
    if (typeof target === "function") {
      const ctx = {
        props: cross(props ?? {}),
        exports,
        waitUntil() {},
        passThroughOnException() {},
      };
      return new (target as new (c: unknown, e: unknown) => any)(ctx, env);
    }
    return target as any;
  };
  return asyncStub(
    (method, args) => {
      const instance = make();
      const fn = instance?.[method];
      if (typeof fn !== "function")
        throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
      return fn.apply(instance, typeof target === "function" ? args : [...args, env, objectCtx()]);
    },
    async (req) => {
      const instance = make();
      if (typeof instance?.fetch !== "function")
        throw new Error("Handler does not export a fetch() function.");
      return typeof target === "function"
        ? instance.fetch(req)
        : instance.fetch(req, env, objectCtx());
    },
  );
}

/** workerd's refusal of `ctx.exports.<Entrypoint>` passed on without `({ props })`. */
const LOOPBACK =
  'Could not serialize object of type "LoopbackServiceStub". This type does not support serialization.';

/**
 * `ctx.exports`: loopback handles of a Worker's named exports. An entrypoint's (a
 * WorkerEntrypoint class, or an object with methods) is a stub (`ctx.exports.Greeter.greet()`),
 * and called with `{ props }` gives one with props; a Durable Object class's is a facet class
 * handle, also callable with `{ props }`.
 */
export function ctxExports(worker: Record<string, unknown>, env: unknown): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(worker)) {
    if (name === "default" || !value || (typeof value !== "function" && typeof value !== "object"))
      continue;
    if (typeof value === "object" || isWorkerEntrypoint(value)) {
      const withProps = (o: { props?: unknown } = {}) => {
        const stub = entrypointStub(value, env, o.props, exports);
        return new Proxy(stub, {
          get: (t, prop) => (prop === EXPORT ? { name, props: o.props } : t[prop as string]),
        });
      };
      const stub = withProps();
      exports[name] = new Proxy(withProps, {
        get: (_t, prop) => (prop === REFUSE ? LOOPBACK : stub[prop as string]),
      });
    } else {
      const handle = (o: { props?: unknown } = {}) =>
        Object.assign(
          classHandle(async () => ({ cls: value as DurableObjectClass, env, props: o.props })),
          { [EXPORT]: { name, props: o.props } },
        );
      exports[name] = Object.assign(
        handle,
        classHandle(async () => ({ cls: value as DurableObjectClass, env })),
      );
    }
  }
  return exports;
}

/**
 * Stubs in Durable Object storage (workerd's `allow_irrevocable_stub_storage`), as V8 host
 * objects: a `ctx.exports.X({ props })` stub or class handle is stored as `[name, props]` and
 * read back as `ctx.exports[name]({ props })`. Other stubs and `RpcTarget`s are refused rather
 * than stored as `{}`.
 */
export function storedExports(exports: Record<string, unknown>): HostObjects {
  const host: HostObjects = {
    encode(v) {
      const e = (v as Record<symbol, { name: string; props: unknown } | undefined>)[EXPORT];
      if (e) return serialize([e.name, e.props], host);
      if ((v as Record<symbol, unknown>)[STUB] === true || isRpcTarget(v))
        throw new DOMException(
          "Only ctx.exports.<name>({ props }) stubs and class handles can be stored.",
          "DataCloneError",
        );
      return undefined;
    },
    decode(bytes) {
      const [name, props] = deserialize(bytes, host) as [string, unknown];
      return (exports[name] as (o: { props: unknown }) => unknown)({ props });
    },
  };
  return host;
}
