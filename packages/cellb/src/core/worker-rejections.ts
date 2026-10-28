/**
 * Unhandled rejections of Worker code, on Node: the Worker's, not the host process's.
 *
 * On workerd and celld a promise the Worker leaves rejected is the Worker's affair: workerd logs
 * it, celld ignores it, and neither stops anything. On Node the Worker runs in the host's
 * process, so such a rejection reached the process's own `unhandledRejection` listeners (a test
 * runner reports it as an error; Node's default ends the process). Each Worker event now runs in
 * a scope that names its runtime, and a rejection raised in that scope goes to the runtime's
 * handler instead: Node calls `unhandledRejection` listeners in the async context of the
 * rejected promise, so the scope is found there.
 *
 * Browsers need none of this: a Worker runs in a worker of its own there.
 */

/** Receives a Worker's unhandled rejection. */
export type RejectionHandler = (reason: unknown, promise: Promise<unknown>) => void;

/** Runs `fn` in a scope whose unhandled rejections go to `handler`. */
export type RejectionScope = <R>(fn: () => R) => R;

interface Als<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}

type NodeProcess = {
  getBuiltinModule?(id: string): unknown;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  stderr?: { write(s: string): unknown };
};

const KEY = Symbol.for("cellb.workerRejections");

/** The scope store, installed once per process (its `process.emit` hook routes by it). */
function install(): Als<RejectionHandler> | undefined {
  const g = globalThis as { process?: NodeProcess } & Record<symbol, unknown>;
  if (g[KEY]) return g[KEY] as Als<RejectionHandler>;
  const proc = g.process;
  const hooks = proc?.getBuiltinModule?.("node:async_hooks") as
    | { AsyncLocalStorage: new <T>() => Als<T> }
    | undefined;
  if (!proc || !hooks) return undefined;
  const scope = new hooks.AsyncLocalStorage<RejectionHandler>();
  const emit = proc.emit;
  // `unhandledRejection` is emitted, not dispatched another way: a Worker's goes to its runtime
  // and no further; everything else reaches the process's listeners as before.
  proc.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
    if (event === "unhandledRejection") {
      const handler = scope.getStore();
      if (handler) {
        handler(args[0], args[1] as Promise<unknown>);
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };
  g[KEY] = scope;
  return scope;
}

/** The default handler: one line on the host's stderr, outside the Worker's own console. */
export function reportToStderr(name: string): RejectionHandler {
  return (reason) => {
    const err = reason as { stack?: string };
    const text = typeof err?.stack === "string" ? err.stack : String(reason);
    const out = (globalThis as { process?: NodeProcess }).process?.stderr;
    out?.write(`[cellb] ${name}: unhandled rejection in Worker code: ${text}\n`);
  };
}

/** A scope routing unhandled rejections to `handler` (on Node; elsewhere `fn` runs as is). */
export function rejectionScope(handler: RejectionHandler): RejectionScope {
  const scope = install();
  return scope ? (fn) => scope.run(handler, fn) : (fn) => fn();
}
