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
  FRAGMENT_TABLE,
  FRAGMENTS_KEY,
  type FragmentShardAdd,
  type FragmentShardInit,
  type FragmentShardRemove,
  type FragmentState,
  type FragmentTable,
  NEED_FRAGMENT_TABLE,
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
  /**
   * Where fragments this host does not serve are (#192): a service binding to one of them goes
   * there over HTTP, from the shard. Unlisted fragments are local.
   */
  routes?: FragmentShardInit["routes"];
  /** The origin of the HTTPeers gateway serving `/peers/{peerId}/…`, for `peer:` routes. */
  peers?: string;
  /**
   * This origin's own peer id (#259): the ServiceWorker serves `<basePath>peers/<peerId>/…` as
   * `<basePath>…`.
   */
  peerId?: string;
}

export interface FragmentTabs extends ProjectTabs {
  /**
   * Load a fragment in every shard this tab runs, and in those it starts later. Resolves with what
   * its configuration declares that this host does not support (the first shard's answer).
   */
  add(id: string, fragment: BrowserFragment): Promise<{ unsupported: string[] }>;
  /**
   * Stop a fragment in the shards this tab runs; its data is kept. The ServiceWorker then answers
   * 404 for it, without waking a shard, unless another tab still has it.
   */
  remove(id: string, options?: { withData?: boolean }): Promise<void>;
  /**
   * Stop a fragment and keep it known as disabled: the ServiceWorker answers 503 for it, without
   * waking a shard, unless another tab has it enabled. Its data is kept.
   */
  disable(id: string): Promise<void>;
  /** Load a disabled fragment again. */
  enable(id: string): Promise<{ unsupported: string[] }>;
  /** The fragments this tab added (enabled or disabled), in order. */
  ids(): string[];
  /** The fragment's state in this tab, or undefined if it never added it. */
  state(id: string): FragmentState | undefined;
}

/** A fragment id: a path segment of lowercase letters, digits, `.`, `_` and `-`. */
const FRAGMENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** The fragment DO binding a fragment names, refused when it has none: as the shards decide it. */
function checkEntry(id: string, fragment: BrowserFragment): void {
  const names = (fragment.config.durable_objects?.bindings ?? []).map((b) => b.name);
  const chosen =
    fragment.entry ??
    (names.includes("FRAGMENT") ? "FRAGMENT" : names.length === 1 ? names[0] : undefined);
  if (!chosen || !names.includes(chosen))
    throw new Error(
      fragment.entry
        ? `"${id}": no Durable Object binding "${fragment.entry}"`
        : `"${id}": no fragment DO: name its binding FRAGMENT, or give its entry`,
    );
}

export async function joinFragmentShards(opts: FragmentTabsOptions): Promise<FragmentTabs> {
  const base = opts.basePath.endsWith("/") ? opts.basePath : `${opts.basePath}/`;
  const fragments = new Map<string, BrowserFragment>();
  // Fragments disabled in this tab: known to the router (503), loaded in no shard.
  const disabled = new Map<string, BrowserFragment>();
  // Every fragment this tab knows, in the order it was added, with its state.
  const states = new Map<string, FragmentState>();

  /** Tells the ServiceWorker this tab's table, and waits until it has it. */
  const announce = async (fragmentsOf: FragmentTable["fragments"] = Object.fromEntries(states)) => {
    const sw = await opts.serviceWorker();
    const { port1, port2 } = new MessageChannel();
    const acked = new Promise<void>((resolve) => {
      port1.onmessage = () => resolve();
      setTimeout(resolve, 2_000); // an older router never answers
    });
    sw.postMessage(
      {
        type: FRAGMENT_TABLE,
        fragments: fragmentsOf,
        ...(opts.peerId ? { peerId: opts.peerId } : {}),
      } satisfies FragmentTable,
      [port2],
    );
    await acked;
    port1.close();
  };
  const onNeedTable = (e: MessageEvent) => {
    if (e.data?.type === NEED_FRAGMENT_TABLE) void announce().catch(() => {});
  };
  navigator.serviceWorker.addEventListener("message", onNeedTable);
  // Per running worker, each fragment's load as it was sent: set at once, so a fragment is sent
  // once, and a removal waits for a load still in flight.
  const workers = new Map<number, { worker: Worker; held: Map<string, Promise<string[]>> }>();
  let ask!: AskShard;

  /** Loads `id` in a worker, once; its unsupported configuration. */
  const load = (worker: Worker, held: Map<string, Promise<string[]>>, id: string) => {
    const known = held.get(id);
    if (known) return known;
    const fragment = fragments.get(id);
    if (!fragment) return Promise.resolve([]);
    const loading = ask(worker, {
      type: FRAGMENT_ADD,
      id,
      ...fragment,
    } satisfies FragmentShardAdd).then((answer) => {
      if (!answer.ok) throw new Error(answer.error);
      return answer.unsupported ?? [];
    });
    held.set(id, loading);
    loading.catch(() => {
      if (held.get(id) === loading) held.delete(id);
    });
    return loading;
  };

  /** Loads every fragment in a worker; one that fails is reported, and the others still load. */
  const loadAll = async (worker: Worker, held: Map<string, Promise<string[]>>, shard: number) => {
    for (const id of [...fragments.keys()]) {
      try {
        const unsupported = await load(worker, held, id);
        if (unsupported.length)
          console.warn(
            `cellb: fragment ${id} (shard ${shard}): unsupported: ${unsupported.join("; ")}`,
          );
      } catch (err) {
        console.error(
          `cellb: fragment ${id} failed in shard ${shard}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
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
        ...(opts.routes ? { routes: opts.routes } : {}),
        ...(opts.peers ? { peers: opts.peers } : {}),
      } satisfies FragmentShardInit);
      if (!started.ok) return started;
      // Every fragment before the router can send it a request.
      const held = new Map<string, Promise<string[]>>();
      workers.set(shard, { worker, held });
      await loadAll(worker, held, shard);
      return { ok: true };
    },
    started(shard) {
      // A fragment added while the shard was starting.
      const w = workers.get(shard);
      if (w) void loadAll(w.worker, w.held, shard);
    },
    stopped(shard) {
      workers.delete(shard);
    },
  });

  const pool: FragmentTabs = {
    ...tabs,
    ids: () => [...states.keys()],
    async add(id, fragment) {
      if (!FRAGMENT_ID.test(id))
        throw new Error(`"${id}" is not a fragment id: lowercase letters, digits, ".", "_", "-"`);
      if (fragments.has(id) || disabled.has(id)) throw new Error(`"${id}" is already on this host`);
      checkEntry(id, fragment);
      fragments.set(id, fragment);
      const running = [...workers.values()];
      const results = await Promise.allSettled(running.map((w) => load(w.worker, w.held, id)));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) {
        // All or nothing: the shards that loaded it let it go again.
        fragments.delete(id);
        for (const [i, r] of results.entries()) {
          const w = running[i];
          if (r.status !== "fulfilled" || !w) continue;
          w.held.delete(id);
          await ask(w.worker, { type: FRAGMENT_REMOVE, id }).catch(() => {});
        }
        throw (failed as PromiseRejectedResult).reason;
      }
      // Removed or disabled while it loaded: that wins (the shards let it go already).
      if (fragments.get(id) !== fragment)
        throw new Error(`"${id}" was removed or disabled while it was being added`);
      states.set(id, "enabled");
      await announce();
      // With no shard running in this tab yet, a shard that loads it later warns what is unsupported.
      const first = results[0];
      return { unsupported: first?.status === "fulfilled" ? first.value : [] };
    },
    state: (id) => states.get(id),
    async remove(id, { withData = false } = {}) {
      if (disabled.delete(id)) {
        states.delete(id);
        await announce();
      } else if (fragments.has(id)) {
        // Unrouted first (404 from the router), then stopped.
        states.delete(id);
        await announce();
        await unload(id);
      } else if (!withData) return;
      // Its data: every shard this tab runs deletes the fragment's pools (statewalker-root#261).
      if (withData)
        for (const w of [...workers.values()]) {
          const answer = await ask(w.worker, {
            type: FRAGMENT_REMOVE,
            id,
            withData: true,
          } satisfies FragmentShardRemove);
          if (!answer.ok) throw new Error(answer.error);
        }
    },
    async disable(id) {
      const fragment = fragments.get(id);
      if (!fragment) {
        if (disabled.has(id)) return;
        throw new Error(`"${id}" is not on this host`);
      }
      // Unrouted first (503 from the router), then stopped.
      disabled.set(id, fragment);
      states.set(id, "disabled");
      await announce();
      await unload(id);
    },
    async enable(id) {
      const fragment = disabled.get(id);
      if (!fragment) {
        if (fragments.has(id)) return { unsupported: [] };
        throw new Error(`"${id}" is not on this host`);
      }
      disabled.delete(id);
      states.delete(id);
      try {
        return await pool.add(id, fragment);
      } catch (err) {
        disabled.set(id, fragment);
        states.set(id, "disabled");
        await announce().catch(() => {});
        throw err;
      }
    },
    async close() {
      navigator.serviceWorker.removeEventListener("message", onNeedTable);
      await announce(null).catch(() => {});
      await tabs.close();
    },
  };
  return pool;

  /** Stops a fragment in the shards this tab runs. */
  async function unload(id: string): Promise<void> {
    if (!fragments.delete(id)) return;
    for (const w of [...workers.values()]) {
      const loading = w.held.get(id);
      if (!loading) continue;
      w.held.delete(id);
      // A load still in flight finishes first (the worker takes messages in order anyway).
      if (
        !(await loading.then(
          () => true,
          () => false,
        ))
      )
        continue;
      const answer = await ask(w.worker, { type: FRAGMENT_REMOVE, id });
      if (!answer.ok) throw new Error(answer.error);
    }
  }
}
