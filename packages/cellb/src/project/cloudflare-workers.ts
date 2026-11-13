/**
 * The `cloudflare:workers` module for Worker code run by cellb (mapped by the
 * bundler / webrun-modules). Exposes the classes Workers code imports.
 */
export { DurableObject, WorkerEntrypoint } from "../core/durable-object.js";

/** Base class of Workflows (`class X extends WorkflowEntrypoint { run(event, step) }`). */
export class WorkflowEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export { RpcTarget } from "../core/durable-object.js";

/** Where an isolate's runtime installs what `abortIsolate` does there (src/isolate/isolate.ts). */
export const ABORT_ISOLATE = Symbol.for("cellb.abort-isolate");

/**
 * workerd's `abortIsolate(reason)`: ends the isolate the calling code runs in, and never returns.
 * In a loaded Worker's isolate, the host terminates it: calls in flight reject, and the next
 * `get()` of its id loads the code again. Elsewhere (a project's own realm, a loaded Worker in
 * the project's realm) there is no isolate of its own to end, so the call only throws.
 */
export function abortIsolate(reason?: unknown): never {
  const abort = (globalThis as Record<symbol, ((r: unknown) => never) | undefined>)[ABORT_ISOLATE];
  if (abort) return abort(reason);
  throw new Error(
    `abortIsolate(${String(reason ?? "")}): this code runs in no isolate of its own (cellb runs only loaded Workers in isolates)`,
  );
}
