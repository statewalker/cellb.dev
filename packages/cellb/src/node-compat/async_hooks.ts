/**
 * `node:async_hooks` AsyncLocalStorage for browsers (nodejs_compat). Browsers have no async
 * context propagation yet (TC39 AsyncContext), so the store is set for the duration of
 * `run()` — including its awaits — and restored afterwards: correct for one run at a time,
 * NOT isolated between concurrent runs (documented limitation).
 */
export class AsyncLocalStorage<T> {
  #store: T | undefined;
  getStore(): T | undefined {
    return this.#store;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.#store;
    this.#store = store;
    let r: R;
    try {
      r = fn(...args);
    } catch (e) {
      this.#store = prev;
      throw e;
    }
    if (r instanceof Promise) return r.finally(() => (this.#store = prev)) as R;
    this.#store = prev;
    return r;
  }
  enterWith(store: T): void {
    this.#store = store;
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return this.run(undefined as T, fn, ...args);
  }
  disable(): void {
    this.#store = undefined;
  }
}
export default { AsyncLocalStorage };
