/** Runs `fn` in an async context captured earlier. */
export type AsyncRoot = <R>(fn: () => R) => R;

const POLYFILL_STATE = Symbol.for("cellb.asyncContext.state");

// biome-ignore lint/suspicious/noExplicitAny: any function, called with its own arguments
type Fn<R = unknown> = (...args: any[]) => R;

/** TC39 AsyncContext (Stage 2), the part cellb uses. */
export interface NativeAsyncContext {
  Variable: new <T>(options?: {
    name?: string;
    defaultValue?: T;
  }) => {
    get(): T | undefined;
    run<R>(value: T, fn: Fn<R>, ...args: unknown[]): R;
  };
  Snapshot: {
    new (): { run<R>(fn: Fn<R>, ...args: unknown[]): R };
    wrap<F extends Fn>(fn: F): F;
  };
}

/**
 * The engine's AsyncContext, when the realm has one: async context then follows every `await`
 * natively, as in workerd, celld and Node, and code needs no lowering.
 */
export function nativeAsyncContext(): NativeAsyncContext | undefined {
  const ac = (globalThis as { AsyncContext?: Partial<NativeAsyncContext> }).AsyncContext;
  return typeof ac?.Variable === "function" && typeof ac.Snapshot === "function"
    ? (ac as NativeAsyncContext)
    : undefined;
}

/**
 * The async context current now, to start events in: on Cloudflare a call to a Durable Object is
 * a new event, which sees no `AsyncLocalStorage` store its caller set. On Node it is every store
 * (`AsyncLocalStorage.snapshot()`); in a browser with AsyncContext, an `AsyncContext.Snapshot`;
 * in other browsers, the `node:async_hooks` polyfill's frame (a realm's polyfill copies share
 * it), or its root frame if the polyfill loads later. Elsewhere events run in their caller's
 * context, as before.
 */
export function asyncRoot(): AsyncRoot {
  const hooks = (
    globalThis as {
      process?: { getBuiltinModule?(id: string): unknown };
    }
  ).process?.getBuiltinModule?.("node:async_hooks") as
    | {
        AsyncLocalStorage?: { snapshot?(): <R>(fn: () => R) => R };
        AsyncResource?: new (type: string) => { runInAsyncScope<R>(fn: () => R): R };
      }
    | undefined;
  const snapshot = hooks?.AsyncLocalStorage?.snapshot?.();
  const Resource = hooks?.AsyncResource;
  // Each event in a resource of its own, made in the snapshot: it inherits the snapshot's stores,
  // and a store an event sets (`run` writes it on the current resource, before Node's
  // AsyncContextFrame) stays its own instead of reaching the next event started in the snapshot.
  if (snapshot && Resource)
    return (fn) => snapshot(() => new Resource("cellb.event").runInAsyncScope(fn));
  const native = nativeAsyncContext();
  if (native) {
    const captured = new native.Snapshot();
    return (fn) => captured.run(fn);
  }
  type State = { root: unknown; current: unknown };
  const realm = globalThis as Record<symbol, State | undefined>;
  const captured = realm[POLYFILL_STATE]?.current;
  return (fn) => {
    const state = realm[POLYFILL_STATE];
    if (!state) return fn();
    const prev = state.current;
    state.current = captured ?? state.root;
    try {
      return fn();
    } finally {
      state.current = prev;
    }
  };
}
