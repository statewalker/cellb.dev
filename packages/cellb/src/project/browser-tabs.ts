/**
 * One project shared by every tab of an origin, its shards balanced over the tabs.
 *
 *   ServiceWorker:  installProjectRouter(self, { basePath: "/app/" })
 *   each page:      joinProjectShards({ name, shards, spawn, config, code, serviceWorker })
 *   shard worker:   serveProjectShard({ sqlite3 })
 *
 * Requests to `<basePath><name>/…` reach the project's Worker through the ServiceWorker, whichever
 * tab sent them (with their URL unchanged, unless `stripBase`); a Durable Object call runs in the
 * shard that owns the object, whichever tab holds that shard.
 *
 * Each tab holds a presence lock; every tab computes the same owner for each shard from the tabs
 * present (`shardOwner`: an even split, oldest tabs first), takes the shards it should own (one
 * Web Lock each) and gives up the others. A shard's OPFS pool belongs to the origin, so its cells
 * move with it from tab to tab. A shard given up is drained first (its requests in flight
 * finish, new ones wait for the next owner); a tab that closes runs no code, so the requests in
 * flight in its shards fail (ShardOwnerLostError) and the other tabs take the shards over.
 */
import { CellRouter } from "../router/cell-router.js";
import { linkOverPort, serveHandlerOverPort } from "../transport/port.js";
import { SW_SOCKET } from "../ws/sw-connector.js";
import { applyWorkerCookies, withPageCookies } from "./browser-cookies.js";
import type { BrowserBucket, BrowserProjectOptions } from "./browser-host.js";
import {
  SHARD_KEEPALIVE,
  SHARD_WAKE,
  TAB_INIT,
  TAB_LINK,
  TAB_WATCH,
  type TabShardInit,
} from "./browser-shards.js";

const ATTACH = "cellb:attach";
const NEED_LINKS = "cellb:need-links";
/** A page opens a socket (`serviceWorkerConnector`). */
const SOCKET = SW_SOCKET;
const DRAIN = "cellb:drain";
/** A shard's call waits for the ServiceWorker: this message starts it, and it asks for links. */
const WAKE = "cellb:wake";
/** Calls between shards are in flight: the message itself resets the ServiceWorker's idle timer. */
const KEEPALIVE = "cellb:keepalive";

/**
 * The tab that should run `shard`: the tabs sorted by id (ids start with the time the tab joined),
 * shard i to tab i mod n — every tab runs ⌊shards/n⌋ or ⌈shards/n⌉ shards. A tab joining or
 * leaving moves the shards whose owner index changes; the oldest tabs keep theirs first.
 */
export function shardOwner(shard: number, tabs: string[]): string | undefined {
  if (!tabs.length) return undefined;
  const sorted = [...tabs].sort();
  return sorted[shard % sorted.length];
}

export interface ProjectTabsOptions {
  /** The project's name in this origin: its URL path, locks and OPFS pools derive from it. */
  name: string;
  shards: number;
  /** Starts the worker of one shard; its script calls `serveProjectShard`. */
  spawn: (shard: number) => Worker;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding. */
  ai?: BrowserProjectOptions["ai"];
  /** Each shard is its own fleet node, `<node>-s<shard>`. */
  bucket?: BrowserBucket;
  /** The active ServiceWorker that runs `installProjectRouter`. */
  serviceWorker: () => Promise<ServiceWorker>;
  /** Called whenever the shards this tab runs change. */
  onChange?: (owned: number[]) => void;
  /** How often the tab checks who is present (tabs that crash release their locks silently). */
  checkMs?: number;
  /**
   * A shard handed to another tab first lets its requests in flight finish, for up to this long
   * (default 5 s); new ones wait for the next owner.
   */
  drainMs?: number;
}

export interface ProjectTabs {
  /** The shards this tab runs now. */
  owned(): number[];
  /** Ids of the tabs present (this one included). */
  tabs(): Promise<string[]>;
  /** Gives up every shard (closing its runtime first) and leaves. */
  close(): Promise<void>;
}

interface Held {
  /** Aborts the wait for the lock, or ends the hold once running. */
  stop: AbortController;
  worker?: Worker;
  running?: Promise<void>;
}

/** The page side: this tab takes part in running the project's shards. */
export async function joinProjectShards(opts: ProjectTabsOptions): Promise<ProjectTabs> {
  const prefix = `cellb:${opts.name}`;
  const tabId = `${Date.now().toString(36).padStart(9, "0")}-${crypto.randomUUID()}`;
  const presenceLock = `${prefix}:tab:${tabId}`;
  let leave!: () => void;
  await new Promise<void>((held) => {
    void navigator.locks.request(presenceLock, () => {
      held();
      return new Promise<void>((r) => (leave = r));
    });
  });
  const channel = new BroadcastChannel(`${prefix}:tabs`);
  const held = new Map<number, Held>();
  const running = new Set<number>();
  let closed = false;

  const tabs = async (): Promise<string[]> => {
    const { held: locks = [] } = await navigator.locks.query();
    const ids = locks
      .map((l) => l.name ?? "")
      .filter((n) => n.startsWith(`${prefix}:tab:`))
      .map((n) => n.slice(`${prefix}:tab:`.length));
    return ids.includes(tabId) ? ids : [...ids, tabId];
  };

  const ask = (w: Worker, data: unknown, ports: MessagePort[] = []) =>
    new Promise<{ ok: boolean; error?: string; ownerLock?: string }>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => {
        port1.close();
        resolve(e.data);
      };
      w.postMessage(data, [port2, ...ports]);
    });

  /** Links a shard's worker to the router (again, after a ServiceWorker restart). */
  const attach = async (shard: number, w: Worker, ownerLock: string) => {
    const down = new MessageChannel(); // router → shard
    const up = new MessageChannel(); // shard → router
    const ctl = new MessageChannel(); // WebSocket port hand-over
    const linked = await ask(w, { type: TAB_LINK }, [down.port2, up.port2, ctl.port2]);
    if (!linked.ok) throw new Error(linked.error);
    const sw = await opts.serviceWorker();
    const routerLock = await new Promise<string>((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => (
        port1.close(), e.data?.ok ? resolve(e.data.routerLock) : reject(new Error(e.data?.error))
      );
      sw.postMessage(
        {
          type: ATTACH,
          name: opts.name,
          shards: opts.shards,
          scriptName: opts.config.name ?? "worker",
          shard,
          ownerLock,
          down: down.port1,
          up: up.port1,
          ctl: ctl.port1,
        },
        [port2, down.port1, up.port1, ctl.port1],
      );
    });
    // The shard drops these links once the ServiceWorker is gone, and wakes it when it needs it.
    const watching = await ask(w, { type: TAB_WATCH, routerLock });
    if (!watching.ok) throw new Error(watching.error);
  };

  /** Starts the ServiceWorker again (WAKE: it asks the tabs for their shards' links), or keeps it up. */
  const tell = async (type: typeof WAKE | typeof KEEPALIVE) => {
    const sw = await opts.serviceWorker();
    sw.postMessage({ type, name: opts.name });
  };
  const owners = new Map<number, string>(); // shard → its worker's owner lock

  /** Asks the router to stop sending the shard new requests and let the current ones finish. */
  const drain = async (shard: number, ownerLock: string) => {
    const sw = await opts.serviceWorker();
    const ms = opts.drainMs ?? 5_000;
    await new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      const t = setTimeout(resolve, ms + 1_000); // a ServiceWorker that does not answer
      port1.onmessage = () => (clearTimeout(t), port1.close(), resolve());
      sw.postMessage({ type: DRAIN, name: opts.name, shard, ownerLock, ms }, [port2]);
    });
  };

  const changed = () => opts.onChange?.([...running].sort((a, b) => a - b));

  /** Waits for the shard's lock, then runs its worker until `stop` is aborted. */
  const take = (shard: number) => {
    const h: Held = { stop: new AbortController() };
    held.set(shard, h);
    h.running = navigator.locks
      .request(`${prefix}:shard:${shard}`, { signal: h.stop.signal }, async () => {
        const w = opts.spawn(shard);
        h.worker = w;
        w.addEventListener("message", (e) => {
          if (e.data?.type === SHARD_WAKE) void tell(WAKE).catch(() => {});
          if (e.data?.type === SHARD_KEEPALIVE) void tell(KEEPALIVE).catch(() => {});
        });
        try {
          const started = await ask(w, {
            type: TAB_INIT,
            name: opts.name,
            shard,
            shards: opts.shards,
            config: opts.config,
            code: opts.code,
            assetFiles: opts.assetFiles,
            ai: opts.ai,
            bucket: opts.bucket && { ...opts.bucket, node: `${opts.bucket.node}-s${shard}` },
            pool: `${opts.name}-shard-${shard}`,
            filesDir: `${opts.name}-files-${shard}`,
          } satisfies TabShardInit);
          if (!started.ok || !started.ownerLock) throw new Error(started.error);
          owners.set(shard, started.ownerLock);
          if (!h.stop.signal.aborted) {
            await attach(shard, w, started.ownerLock);
            running.add(shard);
            changed();
            await new Promise<void>((r) =>
              h.stop.signal.aborted ? r() : h.stop.signal.addEventListener("abort", () => r()),
            );
          }
        } finally {
          // A planned hand-over drains the shard's requests in flight first; then the runtime
          // closes (and the pool with it) before the lock goes to the next tab.
          const lock = owners.get(shard);
          if (lock && running.has(shard)) await drain(shard, lock).catch(() => {});
          running.delete(shard);
          owners.delete(shard);
          await ask(w, { type: "cellb:shard-close" }).catch(() => {});
          w.terminate();
          changed();
        }
      })
      .catch((err) => {
        // Aborted while waiting is expected; a shard that failed to start is reported.
        if (!h.stop.signal.aborted)
          console.error(
            `cellb: ${opts.name} shard ${shard} failed: ${(err as Error)?.message ?? err}`,
          );
      })
      .finally(() => {
        if (held.get(shard) === h) held.delete(shard);
      });
  };

  let balancing: Promise<void> | undefined;
  let again = false;
  /** Takes the shards this tab should own and gives up the others. */
  const balance = async () => {
    if (balancing) {
      again = true;
      return balancing;
    }
    balancing = (async () => {
      do {
        again = false;
        if (closed) return;
        const present = await tabs();
        for (let shard = 0; shard < opts.shards; shard++) {
          const mine = shardOwner(shard, present) === tabId;
          const h = held.get(shard);
          if (mine && !h) take(shard);
          else if (!mine && h) h.stop.abort();
        }
      } while (again);
    })().finally(() => (balancing = undefined));
    return balancing;
  };

  channel.onmessage = () => void balance();
  const timer = setInterval(() => void balance(), opts.checkMs ?? 1000);
  const onSw = (e: MessageEvent) => {
    if (e.data?.type !== NEED_LINKS || (e.data.name && e.data.name !== opts.name)) return;
    for (const shard of running) {
      const w = held.get(shard)?.worker;
      const lock = owners.get(shard);
      if (w && lock) void attach(shard, w, lock).catch(() => {});
    }
  };
  navigator.serviceWorker.addEventListener("message", onSw);
  channel.postMessage({ joined: tabId });
  await balance();

  return {
    owned: () => [...running].sort((a, b) => a - b),
    tabs,
    async close() {
      closed = true;
      clearInterval(timer);
      navigator.serviceWorker.removeEventListener("message", onSw);
      const stopping = [...held.values()];
      for (const h of stopping) h.stop.abort();
      await Promise.all(stopping.map((h) => h.running));
      leave();
      channel.postMessage({ left: tabId });
      channel.close();
    },
  };
}

/** The ServiceWorker side: one CellRouter per project, fed by the tabs' shard workers. */
export function installProjectRouter(
  sw: ServiceWorkerGlobalScope,
  opts: {
    /** Requests to `<basePath><name>/…` go to project `name`. */
    basePath: string;
    /**
     * The Worker sees the request's URL as the page sent it (default), as a Worker on a
     * Cloudflare route does: mount its routes under `<basePath><name>/`. With `stripBase`, it
     * sees `/<rest>` instead — URLs it builds from the request then lack the prefix.
     */
    stripBase?: boolean;
    attachTimeoutMs?: number;
    /**
     * A project served at the origin's root, for apps that build absolute paths (EmDash's
     * `/_emdash/…`, say) and so cannot live under `<basePath><n>/`. Every same-origin request
     * outside `basePath` and outside the `passthrough` path prefixes (the host page's own files)
     * goes to project `name` with its URL unchanged, navigations included.
     *
     * With `hostPage`, a navigation that finds no tab running the project's shards (after
     * `hostWaitMs`, default 2 s, for one to link) is redirected there, with the URL it asked
     * for as `?next=`: the page that starts the project, which a person reopening the site
     * would otherwise never reach, as every path of the origin belongs to the project.
     */
    root?: { name: string; passthrough?: string[]; hostPage?: string; hostWaitMs?: number };
  },
): { routers: Map<string, CellRouter> } {
  const base = opts.basePath.endsWith("/") ? opts.basePath : `${opts.basePath}/`;
  // Held while this ServiceWorker lives: the browser releases it when it stops the worker, which
  // tells the shards that their links to it are dead (MessagePorts report nothing).
  const routerLock = `cellb:router:${crypto.randomUUID()}`;
  const lockHeld = new Promise<void>((held) => {
    void navigator.locks.request(routerLock, () => {
      held();
      return new Promise<void>(() => {});
    });
  });
  const routers = new Map<string, CellRouter>();
  const created = new Map<string, () => void>();
  const ready = new Map<string, Promise<void>>();

  let asking: Promise<void> | undefined;
  const askForLinks = (name?: string) => {
    asking ??= sw.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((cs) => {
        for (const c of cs) c.postMessage({ type: NEED_LINKS, name });
      })
      .finally(() => setTimeout(() => (asking = undefined), 500));
    return asking;
  };

  const routerFor = (name: string, shards: number, scriptName: string) => {
    let router = routers.get(name);
    if (!router) {
      router = new CellRouter({
        shards,
        bindings: {}, // shards name the owner of every internal request (x-cellb-shard)
        scriptName,
        attachTimeoutMs: opts.attachTimeoutMs ?? 15_000,
        onMissingShard: () => void askForLinks(name),
        // The owner worker's own lock: released when it closes, its tab closes or it dies.
        watchOwner: (_shard, ownerLock) =>
          navigator.locks.request(ownerLock as string, async () => {}),
        isAlive: async (_shard, ownerLock) =>
          !!(await navigator.locks.query()).held?.some((l) => l.name === ownerLock),
        livenessIntervalMs: 5_000,
      });
      routers.set(name, router);
      created.get(name)?.();
    }
    return router;
  };

  /** A project's router; after a ServiceWorker restart, once a tab has attached a shard again. */
  const routerNamed = (name: string): Promise<CellRouter> => {
    const r = routers.get(name);
    if (r) return Promise.resolve(r);
    let wait = ready.get(name);
    if (!wait) {
      wait = new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`project ${name} has no shards in any tab`)),
          opts.attachTimeoutMs ?? 15_000,
        );
        created.set(name, () => (clearTimeout(t), resolve()));
      }).finally(() => (ready.delete(name), created.delete(name)));
      ready.set(name, wait);
      void askForLinks(name);
    }
    return wait.then(() => routers.get(name)!);
  };

  sw.addEventListener("message", (e: ExtendableMessageEvent) => {
    const m = e.data;
    const reply = e.ports[0];
    if (m?.type === ATTACH)
      e.waitUntil(
        (async () => {
          try {
            const router = routerFor(m.name, m.shards, m.scriptName);
            await serveHandlerOverPort(m.up, router.internal);
            const link = await linkOverPort(m.down);
            router.attach(m.shard, link.send, m.ownerLock, m.ctl);
            await lockHeld;
            reply?.postMessage({ ok: true, routerLock });
          } catch (err) {
            reply?.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
          }
        })(),
      );
    else if (m?.type === DRAIN)
      e.waitUntil(
        (async () => {
          await routers.get(m.name)?.drain(m.shard, m.ownerLock, m.ms);
          reply?.postMessage({ ok: true });
        })(),
      );
    else if (m?.type === WAKE)
      // Started by this message: stay up until a tab has linked the project's shards again.
      e.waitUntil(routerNamed(m.name).catch(() => {}));
    else if (m?.type === SOCKET)
      e.waitUntil(
        (async () => {
          try {
            const { name, path } = split(new URL(m.url));
            const url = new URL(m.url);
            if (opts.stripBase && !atRoot(url)) url.pathname = path;
            const { port, protocol } = await (await routerNamed(name)).connectWebSocket(
              url.toString(),
              m.protocols ?? [],
            );
            reply.postMessage({ ok: true, port, protocol }, [port]);
          } catch (err) {
            reply.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
          }
        })(),
      );
  });

  /** Whether `url` goes to the root project (`opts.root`). */
  const atRoot = (url: URL) =>
    !!opts.root &&
    url.origin === sw.location.origin &&
    !url.pathname.startsWith(base) &&
    !(opts.root.passthrough ?? []).some((p) => url.pathname.startsWith(p));

  /** `<base><name>/<rest>` → the project's name and the Worker's path `/<rest>`. */
  const split = (url: URL) => {
    if (opts.root && atRoot(url)) return { name: opts.root.name, path: url.pathname };
    if (!url.pathname.startsWith(base)) throw new Error(`not a project URL: ${url}`);
    const rest = url.pathname.slice(base.length);
    const slash = rest.indexOf("/");
    const name = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    return { name, path: slash < 0 ? "/" : rest.slice(slash) };
  };

  sw.addEventListener("fetch", (e: FetchEvent) => {
    const url = new URL(e.request.url);
    const root = atRoot(url);
    if (!root) {
      if (url.origin !== sw.location.origin || !url.pathname.startsWith(base)) return;
      if (e.request.mode === "navigate") return;
    }
    const { name, path } = split(url);
    if (!name) return;
    const req = e.request;
    const target = opts.stripBase && !root ? new URL(`${path}${url.search}`, url.origin) : url;
    const hostPage = root && req.mode === "navigate" ? opts.root?.hostPage : undefined;
    if (hostPage)
      e.respondWith(
        runningShards(name, opts.root?.hostWaitMs ?? 2_000).then((running) =>
          running
            ? serve(name, req, target)
            : Response.redirect(
                `${new URL(hostPage, url.origin).href}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
                302,
              ),
        ),
      );
    else e.respondWith(serve(name, req, target));
  });

  /** Whether a tab runs project `name`'s shards, waiting up to `ms` for one to link. */
  const runningShards = async (name: string, ms: number): Promise<boolean> => {
    const live = () => (routers.get(name)?.attachedShards.length ?? 0) > 0;
    if (live()) return true;
    void askForLinks(name);
    for (const until = Date.now() + ms; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100));
      if (live()) return true;
    }
    return false;
  };

  /** A request to project `name`, with the page's cookies in and the Worker's out. */
  const serve = (name: string, req: Request, target: URL): Promise<Response> =>
    routerNamed(name).then(
      async (router) => {
        try {
          return await applyWorkerCookies(
            sw,
            await router.ingress(
              new Request(target, {
                method: req.method,
                headers: await withPageCookies(sw, req),
                body: req.body,
                signal: req.signal,
                duplex: "half",
              } as RequestInit),
            ),
          );
        } catch (err) {
          // A response the page can read, instead of a network error with no cause.
          console.error(`cellb: ${req.method} ${target.pathname} failed:`, err);
          return new Response(`cellb: ${(err as Error)?.stack ?? err}`, { status: 502 });
        }
      },
      (err) => new Response(String((err as Error)?.message ?? err), { status: 503 }),
    );

  return { routers };
}
