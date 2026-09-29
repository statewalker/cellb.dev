import { type CellRuntime, type CellRuntimeOptions, createCellRuntime } from "../core/runtime.js";
import { shardOf } from "../core/shard.js";
import type { Send } from "../transport/cells-http.js";
import { type CellPort, linkOverPort, serveRuntime } from "../transport/port.js";

export interface ShardHostOptions extends Omit<CellRuntimeOptions, "route"> {
  shard: number;
  shards: number;
}

export interface ShardHost {
  readonly runtime: CellRuntime;
  /**
   * (Re)connects to a router: `down` = router → shard (served here),
   * `up` = shard → router (for DO calls into other shards). Called again when
   * the router restarts (a ServiceWorker is killed when idle and loses its ports).
   */
  link(down: CellPort, up: CellPort): Promise<void>;
}

/** Runs one shard: hosts the cells of shard `shard`, forwards the others upstream. */
export function createShardHost(opts: ShardHostOptions): ShardHost {
  let upstream: Send | undefined;
  const pending: (() => void)[] = [];
  const up: Send = async (req) => {
    while (!upstream) await new Promise<void>((r) => pending.push(r));
    return upstream(req);
  };
  const runtime = createCellRuntime({
    ...opts,
    vars: { ...opts.vars, SHARD: opts.shard },
    route: (_key, id) => (shardOf(id.toString(), opts.shards) === opts.shard ? undefined : up),
  });
  let stopDown: (() => Promise<void>) | undefined;
  let closeUp: (() => Promise<void>) | undefined;
  return {
    runtime,
    async link(down, upPort) {
      const [prevStop, prevClose] = [stopDown, closeUp];
      stopDown = await serveRuntime(down, runtime);
      const l = await linkOverPort(upPort);
      closeUp = l.close;
      upstream = l.send;
      for (const w of pending.splice(0)) w();
      await Promise.allSettled([prevStop?.(), prevClose?.()]);
    },
  };
}
