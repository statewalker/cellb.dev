import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  type CellDurability,
  createCellRuntime,
  DurableObject,
  type DurableObjectState,
  type OpenCellSql,
  runInDurableObject,
} from "../src/index.js";

/** A probe object exposing ctx to the test through RPC closures. */
export class Probe extends DurableObject {
  static constructed = 0;
  static init: ((ctx: DurableObjectState) => Promise<void>) | undefined;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    Probe.constructed++;
    const init = Probe.init;
    if (init) ctx.blockConcurrencyWhile(() => init(ctx));
  }
  #kept: number[] = [];
  /** Mutates its argument and returns internal state: both must be copies across the stub. */
  keep(arr: number[]): number[] {
    arr.push(99);
    this.#kept = arr;
    return this.#kept;
  }
  kept(): number[] {
    return this.#kept;
  }
}

export function probeRuntime(opts: { openSql?: OpenCellSql; durability?: CellDurability } = {}) {
  const rt = createCellRuntime({
    worker: { Probe, default: {} },
    durableObjects: { PROBE: { className: "Probe" } },
    openSql: opts.openSql ?? nodeSqliteOpener(),
    durability: opts.durability,
  });
  const ns = rt.env.PROBE as any;
  /** Runs `fn(ctx)` inside object `name`, through the gates. */
  const inObject = <T>(
    name: string,
    fn: (ctx: DurableObjectState) => T | Promise<T>,
  ): Promise<Awaited<T>> =>
    runInDurableObject(ns.getByName(name), (_obj, ctx) => fn(ctx)) as Promise<Awaited<T>>;
  return { rt, ns, inObject };
}
