/** `env` and `exports` of `cloudflare:workers` for one project's Worker code. */
export interface WorkerScope {
  readonly env: Record<string, unknown>;
  readonly exports: Record<string, unknown>;
  /**
   * `waitUntil` of `cloudflare:workers`: the promise runs in the runtime's background (until its
   * `drain()`); before the scope is bound to a runtime, it just runs.
   */
  readonly waitUntil: (p: Promise<unknown>) => void;
  /** Points both at the runtime's own objects (the ones `fetch` and `ctx.exports` see). */
  bind(runtime: {
    env: Record<string, unknown>;
    exports: Record<string, unknown>;
    waitUntil?: (p: Promise<unknown>) => void;
  }): void;
}

/**
 * A scope whose `env` serves `vars` until it is bound to a runtime: the code reads `env` while
 * its module is evaluated, before the runtime that builds the bindings exists.
 */
export function workerScope(vars: Record<string, unknown> = {}): WorkerScope {
  let env: Record<string, unknown> = { ...vars };
  let exports: Record<string, unknown> = {};
  let background: ((p: Promise<unknown>) => void) | undefined;
  const forward = (target: () => Record<string, unknown>) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_, k) => Reflect.get(target(), k),
      set: (_, k, v) => Reflect.set(target(), k, v),
      has: (_, k) => Reflect.has(target(), k),
      deleteProperty: (_, k) => Reflect.deleteProperty(target(), k),
      ownKeys: () => Reflect.ownKeys(target()),
      getOwnPropertyDescriptor: (_, k) => {
        const d = Reflect.getOwnPropertyDescriptor(target(), k);
        return d && { ...d, configurable: true };
      },
    });
  return {
    env: forward(() => env),
    exports: forward(() => exports),
    waitUntil: (p) => {
      if (background) background(p);
      else void Promise.resolve(p).catch(() => {}); // a rejection is the code's own, unreported
    },
    bind(runtime) {
      env = runtime.env;
      exports = runtime.exports;
      background = runtime.waitUntil ?? background;
    },
  };
}

/**
 * The scope of the Worker a loaded Worker's isolate runs, made on first use. It is
 * `globalThis.__cellsProjectScope`, which the realm's `cloudflare:workers` reads, as a browser
 * project's bundle reads its own (`PROJECT_WORKERS_MODULE_SHIM`).
 */
export function realmWorkerScope(): WorkerScope {
  const g = globalThis as { __cellsProjectScope?: WorkerScope };
  g.__cellsProjectScope ??= workerScope();
  return g.__cellsProjectScope;
}
