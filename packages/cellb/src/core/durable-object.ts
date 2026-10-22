import type { DurableObjectState } from "./state.js";

/** Stand-in for `import { DurableObject } from "cloudflare:workers"` (mapped via webrun-modules ~deps/ in P08). */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Marker base class for JS-RPC targets returned by reference (`cloudflare:workers`). */
export class RpcTarget {}
