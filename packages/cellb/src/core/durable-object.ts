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

/** Brands WorkerEntrypoint subclasses across copies of this module (a loaded Worker bundles its own). */
const ENTRYPOINT = Symbol.for("cellb.WorkerEntrypoint");

export const isWorkerEntrypoint = (v: unknown): boolean =>
  typeof v === "function" && (v as unknown as Record<symbol, unknown>)[ENTRYPOINT] === true;

export class WorkerEntrypoint<Env = unknown> {
  static readonly [ENTRYPOINT] = true;
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

/** Brands RpcTarget instances across copies of this module (a loaded Worker bundles its own). */
const RPC_TARGET = Symbol.for("cellb.RpcTarget");

export const isRpcTarget = (v: unknown): boolean =>
  !!v && typeof v === "object" && (v as Record<symbol, unknown>)[RPC_TARGET] === true;

/** Marker base class for JS-RPC targets returned by reference (`cloudflare:workers`). */
export class RpcTarget {
  get [RPC_TARGET]() {
    return true;
  }
}
