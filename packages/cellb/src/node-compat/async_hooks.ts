/**
 * `node:async_hooks` AsyncLocalStorage for browsers (nodejs_compat). Browsers have no async
 * context propagation (TC39 AsyncContext), and a native `await` resumes without calling any
 * user code, so no shim can follow it. Two mechanisms, together:
 *
 * - Every `Promise.prototype.then` callback runs with the stores that were current when it
 *   was registered. Code whose `async`/`await` is compiled to generators awaits through
 *   `then`, so its stores are exact and separate between concurrent runs.
 * - For native `await`, `run()` leaves its store set until its promise settles (correct for
 *   one run at a time, NOT isolated between concurrent runs: documented limitation).
 */

/** The store of every AsyncLocalStorage at this point of execution (a frame). */
let current = new Map<AsyncLocalStorage<unknown>, unknown>();
const nativeThen = Promise.prototype.then;
let patched = false;

/** `fn` run with `frame` as the current stores, restoring the caller's afterwards. */
function inFrame<F>(fn: F, frame: typeof current): F {
  if (typeof fn !== "function") return fn;
  return function (this: unknown, ...args: unknown[]) {
    const prev = current;
    current = frame;
    try {
      return fn.apply(this, args);
    } finally {
      current = prev;
    }
  } as F;
}

function patchThen(): void {
  if (patched) return;
  patched = true;
  // biome-ignore lint/suspicious/noThenProperty: the shim works by wrapping every `then`.
  Promise.prototype.then = function (this: Promise<unknown>, onFulfilled, onRejected) {
    return nativeThen.call(this, inFrame(onFulfilled, current), inFrame(onRejected, current));
  } as typeof Promise.prototype.then;
}

/** `frame` with this storage's store set to `store` (`undefined` removes it). */
function withStore(frame: typeof current, als: AsyncLocalStorage<unknown>, store: unknown) {
  const next = new Map(frame);
  if (store === undefined) next.delete(als);
  else next.set(als, store);
  return next;
}

export class AsyncLocalStorage<T> {
  constructor() {
    patchThen();
  }
  getStore(): T | undefined {
    return current.get(this as AsyncLocalStorage<unknown>) as T | undefined;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const self = this as AsyncLocalStorage<unknown>;
    const prev = current.get(self);
    const restore = () => (current = withStore(current, self, prev));
    current = withStore(current, self, store);
    let r: R;
    try {
      r = fn(...args);
    } catch (e) {
      restore();
      throw e;
    }
    if (!(r instanceof Promise)) {
      restore();
      return r;
    }
    // Native `then`: the restoring callback must change the stores outside any frame.
    return nativeThen.call(
      r,
      (v) => (restore(), v),
      (e) => {
        restore();
        throw e;
      },
    ) as R;
  }
  enterWith(store: T): void {
    current = withStore(current, this as AsyncLocalStorage<unknown>, store);
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return this.run(undefined as T, fn, ...args);
  }
  disable(): void {
    current = withStore(current, this as AsyncLocalStorage<unknown>, undefined);
  }
}
export default { AsyncLocalStorage };
