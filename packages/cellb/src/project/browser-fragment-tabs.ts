/**
 * The page side of the fragment host in a browser (#191): this tab takes part in running the
 * origin's one pool of shard workers (`serveFragmentShard`), each of which holds every fragment the
 * tabs added. The shards are balanced over the tabs as a project's are (`joinProjectShards`), and
 * the ServiceWorker's router (`installProjectRouter`) sends `<basePath>fragments/<id>/…` to them.
 *
 * Every tab adds the same fragments (the enabled ones, from the user's profile): a shard this tab
 * starts is given the fragments this tab holds, and a fragment added or removed here reaches the
 * shards this tab runs.
 */
import {
  FRAGMENT_ADD,
  FRAGMENT_REMOVE,
  FRAGMENT_SHARD_INIT,
  FRAGMENTS_KEY,
  type FragmentShardAdd,
  type FragmentShardInit,
} from "./browser-tab-protocol.js";
import {
  type AskShard,
  joinShardPool,
  type ProjectTabs,
  type ProjectTabsOptions,
} from "./browser-tabs.js";

/** A fragment's server half, as the tabs add it. */
export type BrowserFragment = Omit<FragmentShardAdd, "type" | "id">;

export interface FragmentTabsOptions
  extends Pick<
    ProjectTabsOptions,
    "shards" | "serviceWorker" | "onChange" | "checkMs" | "drainMs"
  > {
  /** Starts the worker of one shard; its script calls `serveFragmentShard`. */
  spawn: (shard: number) => Worker;
  /** The ServiceWorker router's `basePath`: fragments are served at `<basePath>fragments/<id>/`. */
  basePath: string;
}

export interface FragmentTabs extends ProjectTabs {
  /**
   * Load a fragment in every shard this tab runs, and in those it starts later. Resolves with what
   * its configuration declares that this host does not support (the first shard's answer).
   */
  add(id: string, fragment: BrowserFragment): Promise<{ unsupported: string[] }>;
  /** Stop a fragment in the shards this tab runs; its data is kept. */
  remove(id: string): Promise<void>;
  /** The fragments this tab added, in order. */
  ids(): string[];
}

/** A fragment id: a path segment of lowercase letters, digits, `.`, `_` and `-`. */
const FRAGMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export async function joinFragmentShards(opts: FragmentTabsOptions): Promise<FragmentTabs> {
  const base = opts.basePath.endsWith("/") ? opts.basePath : `${opts.basePath}/`;
  const fragments = new Map<string, BrowserFragment>();
  const workers = new Map<number, { worker: Worker; held: Set<string> }>();
  let ask!: AskShard;

  /** Loads `id` in a worker, once. */
  const load = async (worker: Worker, held: Set<string>, id: string) => {
    const fragment = fragments.get(id);
    if (!fragment || held.has(id)) return [];
    const answer = await ask(worker, {
      type: FRAGMENT_ADD,
      id,
      ...fragment,
    } satisfies FragmentShardAdd);
    if (!answer.ok) throw new Error(answer.error);
    held.add(id);
    return answer.unsupported ?? [];
  };

  const tabs = await joinShardPool({
    name: FRAGMENTS_KEY,
    label: "the fragment host",
    shards: opts.shards,
    spawn: opts.spawn,
    serviceWorker: opts.serviceWorker,
    onChange: opts.onChange,
    checkMs: opts.checkMs,
    drainMs: opts.drainMs,
    async start(worker, shard, askShard) {
      ask = askShard;
      const started = await askShard(worker, {
        type: FRAGMENT_SHARD_INIT,
        shard,
        shards: opts.shards,
        prefix: `${base}${FRAGMENTS_KEY}/`,
      } satisfies FragmentShardInit);
      if (!started.ok) return started;
      // Every fragment before the router can send it a request.
      const held = new Set<string>();
      workers.set(shard, { worker, held });
      try {
        for (const id of [...fragments.keys()]) await load(worker, held, id);
      } catch (err) {
        workers.delete(shard);
        return { ok: false, error: String((err as Error)?.message ?? err) };
      }
      return { ok: true };
    },
    started(shard) {
      // A fragment added while the shard was starting.
      const w = workers.get(shard);
      if (w) for (const id of fragments.keys()) void load(w.worker, w.held, id).catch(() => {});
    },
    stopped(shard) {
      workers.delete(shard);
    },
  });

  return {
    ...tabs,
    ids: () => [...fragments.keys()],
    async add(id, fragment) {
      if (!FRAGMENT_ID.test(id))
        throw new Error(`"${id}" is not a fragment id: lowercase letters, digits, ".", "_", "-"`);
      if (fragments.has(id)) throw new Error(`"${id}" is already on this host`);
      fragments.set(id, fragment);
      try {
        let unsupported: string[] | undefined;
        for (const w of [...workers.values()]) {
          const found = await load(w.worker, w.held, id);
          unsupported ??= found;
        }
        return { unsupported: unsupported ?? [] };
      } catch (err) {
        fragments.delete(id);
        throw err;
      }
    },
    async remove(id) {
      if (!fragments.delete(id)) return;
      for (const w of [...workers.values()]) {
        if (!w.held.delete(id)) continue;
        const answer = await ask(w.worker, { type: FRAGMENT_REMOVE, id });
        if (!answer.ok) throw new Error(answer.error);
      }
    },
  };
}
