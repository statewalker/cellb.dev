/**
 * The `cloudflare:workers` module for Worker code run by cellb (mapped by the
 * bundler / webrun-modules). Exposes the classes Workers code imports.
 */
import { forwardTo, type WorkerScope } from "./worker-scope.js";

export { DurableObject, WorkerEntrypoint } from "../core/durable-object.js";

/**
 * `env` and `exports` of the Worker this realm runs (`setRealmWorkerScope`); empty objects in a
 * realm without one. A Node project's bundle and in-realm loaded code get their own instead.
 */
const realm = () => (globalThis as { __cellsWorkerScope?: WorkerScope }).__cellsWorkerScope;
export const env = forwardTo(() => realm()?.env ?? {});
export const exports = forwardTo(() => realm()?.exports ?? {});

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
