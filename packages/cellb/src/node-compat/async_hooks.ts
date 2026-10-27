/**
 * `node:async_hooks` AsyncLocalStorage for browsers (nodejs_compat). Browsers have no async
 * context propagation yet (TC39 AsyncContext), so this is the polyfill's design:
 *
 * - a context is an immutable frame (store per AsyncLocalStorage); `run()` makes its frame
 *   current for the synchronous part of the call only;
 * - `installAsyncContext()` makes continuations carry the frame that was current when they
 *   were scheduled: `Promise.prototype.then` (so `catch`, `finally` and `await` on a thenable),
 *   `setTimeout`, `setInterval` and `queueMicrotask`;
 * - a native `await` does not call `then`, so code that relies on propagation is compiled with
 *   `async`/`await` lowered to generators (with nodejs_compat, `bundleWorkerForBrowser` does it
 *   with esbuild, an in-browser site with `lowerAwait`): each `await` then goes through
 *   `Promise.prototype.then`.
 *
 * Code that is not lowered (cellb itself) resumes after a native `await` in the root frame: it
 * neither sees nor leaks another event's stores.
 *
 * Without `installAsyncContext()` (code compiled without lowering), `run()` keeps its store set
 * until its promise settles instead: one run at a time sees its store after `await`, concurrent
 * runs share whichever was set last.
 */
type Frame = ReadonlyMap<AsyncLocalStorage<unknown>, unknown>;

// One state per realm: a browser bundle carries its own copy of this module (node:async_hooks
// bundled in), and its stores must be the frames that cellb's patched `then` restores.
const STATE = Symbol.for("cellb.asyncContext.state");
const realm = globalThis as Record<symbol, unknown>;
if (!realm[STATE]) {
  const root: Frame = new Map();
  realm[STATE] = { root, current: root, propagate: false };
}
const state = realm[STATE] as { root: Frame; current: Frame; propagate: boolean };
const ROOT = state.root;

function runIn<R>(
  frame: Frame,
  fn: (...args: unknown[]) => R,
  thisArg: unknown,
  args: unknown[],
): R {
  const prev = state.current;
  state.current = frame;
  try {
    return fn.apply(thisArg, args);
  } finally {
    state.current = prev;
  }
}

/** `fn` bound to the frame current now. */
// biome-ignore lint/suspicious/noExplicitAny: any function, called with its own arguments
function bindToCurrent<F extends (...args: any[]) => unknown>(fn: F): F {
  const frame = state.current;
  if (frame === ROOT) return fn; // nothing to carry; the callback runs in the root frame anyway
  return function (this: unknown, ...args: unknown[]) {
    return runIn(frame, fn, this, args);
  } as F;
}

export class AsyncLocalStorage<T> {
  getStore(): T | undefined {
    return state.current.get(this as AsyncLocalStorage<unknown>) as T | undefined;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const frame = new Map(state.current).set(this as AsyncLocalStorage<unknown>, store);
    if (state.propagate) return runIn(frame, fn, undefined, args);
    // Without installAsyncContext() (code whose `await` is not lowered): the store stays set
    // until the run's promise settles — right for one run at a time, shared between concurrent
    // ones.
    const prev = state.current;
    state.current = frame;
    let r: R;
    try {
      r = fn(...args);
    } catch (e) {
      state.current = prev;
      throw e;
    }
    if (r instanceof Promise)
      return r.finally(() => {
        state.current = prev;
      }) as R;
    state.current = prev;
    return r;
  }
  /** The store for the rest of the current synchronous part and what it schedules. */
  enterWith(store: T): void {
    state.current = new Map(state.current).set(this as AsyncLocalStorage<unknown>, store);
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const frame = new Map(state.current);
    frame.delete(this as AsyncLocalStorage<unknown>);
    return runIn(frame, fn, undefined, args);
  }
  disable(): void {
    if (!state.current.has(this as AsyncLocalStorage<unknown>)) return;
    const frame = new Map(state.current);
    frame.delete(this as AsyncLocalStorage<unknown>);
    state.current = frame;
  }
  /** `fn` bound to the current stores. */
  // biome-ignore lint/suspicious/noExplicitAny: any function, called with its own arguments
  static bind<F extends (...args: any[]) => unknown>(fn: F): F {
    return bindToCurrent(fn);
  }
  /** Runs a function later in the stores current now. */
  static snapshot(): <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => R {
    const frame = state.current;
    return (fn, ...args) => runIn(frame, fn, undefined, args);
  }
}

const INSTALLED = Symbol.for("cellb.asyncContext");

/**
 * Makes continuations carry the current stores, in the realm of `g` (a browser worker that runs
 * Worker code). Idempotent.
 */
export function installAsyncContext(g: typeof globalThis = globalThis): void {
  const proto = g.Promise.prototype as Promise<unknown> & { [INSTALLED]?: true };
  if (proto[INSTALLED]) return;
  Object.defineProperty(proto, INSTALLED, { value: true });
  state.propagate = true;
  type Callback = ((value: unknown) => unknown) | null | undefined;
  function then(this: Promise<unknown>, onFulfilled?: Callback, onRejected?: Callback) {
    return original.call(
      this,
      typeof onFulfilled === "function" ? bindToCurrent(onFulfilled) : onFulfilled,
      typeof onRejected === "function" ? bindToCurrent(onRejected) : onRejected,
    );
  }
  const original = proto.then;
  // biome-ignore lint/suspicious/noThenProperty: replacing Promise.prototype.then is the point
  Object.defineProperty(proto, "then", { value: then, writable: true, configurable: true });
  const timer = <F extends typeof g.setTimeout | typeof g.setInterval>(schedule: F) =>
    function (this: unknown, handler: unknown, ...rest: unknown[]) {
      const h = typeof handler === "function" ? bindToCurrent(handler as () => unknown) : handler;
      return (schedule as (...a: unknown[]) => unknown).call(this ?? g, h, ...rest);
    } as unknown as F;
  g.setTimeout = timer(g.setTimeout);
  g.setInterval = timer(g.setInterval);
  const queue = g.queueMicrotask;
  g.queueMicrotask = (cb: VoidFunction) => queue.call(g, bindToCurrent(cb));
}

export default { AsyncLocalStorage, installAsyncContext };
