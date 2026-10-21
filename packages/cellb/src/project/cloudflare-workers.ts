/**
 * The `cloudflare:workers` module for Worker code run by webrun-cells (mapped by the
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

/** Marker base class for JS-RPC targets returned by value. */
export class RpcTarget {}
