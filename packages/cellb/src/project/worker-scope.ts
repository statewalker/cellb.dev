/**
 * `env` and `exports` of `cloudflare:workers` for one Worker. Code reads them while its module
 * is evaluated, before the runtime exists: until `bind()`, `env` serves the Worker's vars (or
 * its WorkerCode env) and `exports` is empty; then both forward to the runtime's own objects.
 */
export interface WorkerScope {
  readonly env: Record<string, unknown>;
  readonly exports: Record<string, unknown>;
  /** Points both at the runtime's own objects (the ones `fetch` and `ctx.exports` see). */
  bind(runtime: { env: Record<string, unknown>; exports: Record<string, unknown> }): void;
}

/** An object that reads and writes through to `target()` at each access. */
export function forwardTo(target: () => Record<string, unknown>): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
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
}

export function workerScope(env: Record<string, unknown> = {}): WorkerScope {
  let current = { env: { ...env }, exports: {} as Record<string, unknown> };
  return {
    env: forwardTo(() => current.env),
    exports: forwardTo(() => current.exports),
    bind(runtime) {
      current = runtime;
    },
  };
}

/**
 * The scope of the one Worker a realm runs (a loaded Worker's isolate, a browser project's
 * worker): what `env` and `exports` of the realm's `cloudflare:workers` read. A realm global,
 * because the module may be bundled more than once into a realm.
 */
export function setRealmWorkerScope(scope: WorkerScope): void {
  (globalThis as { __cellsWorkerScope?: WorkerScope }).__cellsWorkerScope = scope;
}

/** Scopes registered for generated `cloudflare:workers` modules (one per bundle or load). */
export function registerWorkerScope(scope: WorkerScope): string {
  const g = globalThis as { __cellsWorkerScopes?: Record<string, WorkerScope> };
  const key = `s${Math.random().toString(36).slice(2)}`;
  g.__cellsWorkerScopes ??= {};
  g.__cellsWorkerScopes[key] = scope;
  return key;
}
