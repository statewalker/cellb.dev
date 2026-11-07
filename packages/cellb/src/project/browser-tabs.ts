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
import {
  type DispatchFailure,
  type HandlerInfo,
  LinkLostError,
  SwHttpAdapter,
  SwHttpDispatcher,
  type WorkerLink,
} from "@statewalker/webrun-http-browser/sw";
import { ShardOwnerLostError } from "../router/cell-router.js";
import { errorResponse } from "../transport/cells-http.js";
import { H } from "../transport/cells-link.js";
import { SW_SOCKET } from "../ws/sw-connector.js";
import { applyWorkerCookies, withPageCookies } from "./browser-cookies.js";
import type { BrowserBucket, BrowserProjectOptions } from "./browser-host.js";
import { INTERNAL_ORIGIN, TAB_INIT, type TabShardInit } from "./browser-shards.js";

/** The ServiceWorker asks a project's tabs to attach their shards again (a host page's wait). */
const NEED_LINKS = "cellb:need-links";
/** A page opens a socket (`serviceWorkerConnector`). */
const SOCKET = SW_SOCKET;

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
  /**
   * The active ServiceWorker that runs `installProjectRouter`. This page must be inside its scope
   * and controlled by it (webrun-http-browser's adapter asks the worker to claim the page if it
   * is not, and rejects with a `ServiceWorkerControlError` after 30 s if that fails: after a hard
   * reload, say).
   */
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

/** A shard's handler id under the project's key: the router's `route` picks shards by it. */
const shardId = (shard: number) => `shard:${shard}`;

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
    new Promise<{
      ok: boolean;
      error?: string;
      unsupported?: string[];
    }>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => {
        port1.close();
        resolve(e.data);
      };
      w.postMessage(data, [port2, ...ports]);
    });

  // The tab's side of the ServiceWorker's router (webrun-http-browser): it attaches this tab's
  // shard workers under the project's key, and attaches them again whenever the ServiceWorker
  // asks (after a restart). The page itself attaches no handler the router would pick.
  const worker = await opts.serviceWorker();
  // The given worker's registration, not `navigator.serviceWorker.ready` (that is this page's
  // scope's registration, and never settles for a page outside every scope).
  const registration = (await navigator.serviceWorker.getRegistrations()).find((r) =>
    [r.active, r.waiting, r.installing].includes(worker),
  );
  if (!registration)
    throw new Error(`cellb: no registration holds the ServiceWorker ${worker.scriptURL}`);
  const adapter = new SwHttpAdapter({
    key: opts.name,
    registration,
    id: `tab:${tabId}`,
  });
  await adapter.start();
  const links = new Map<number, WorkerLink>();

  const changed = () => opts.onChange?.([...running].sort((a, b) => a - b));

  /** Waits for the shard's lock, then runs its worker until `stop` is aborted. */
  const take = (shard: number) => {
    const h: Held = { stop: new AbortController() };
    held.set(shard, h);
    h.running = navigator.locks
      .request(`${prefix}:shard:${shard}`, { signal: h.stop.signal }, async () => {
        const w = opts.spawn(shard);
        h.worker = w;
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
          if (!started.ok) throw new Error(started.error);
          // What the configuration asks for and this runtime does not provide (a cron trigger
          // without a scheduled() handler, say): said once, not silently ignored.
          if (started.unsupported?.length)
            console.warn(
              `cellb: project ${opts.name} shard ${shard}: unsupported: ${started.unsupported.join("; ")}`,
            );
          if (!h.stop.signal.aborted) {
            links.set(
              shard,
              await adapter.attachWorker(w, {
                key: opts.name,
                id: shardId(shard),
                meta: { shard },
              }),
            );
            running.add(shard);
            changed();
            await new Promise<void>((r) =>
              h.stop.signal.aborted ? r() : h.stop.signal.addEventListener("abort", () => r()),
            );
          }
        } finally {
          // A planned hand-over drains the shard's requests in flight first; then the runtime
          // closes (and the pool with it) before the lock goes to the next tab.
          const link = links.get(shard);
          links.delete(shard);
          if (link && running.has(shard))
            await link.drain({ ms: opts.drainMs ?? 5_000 }).catch(() => {});
          running.delete(shard);
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
        // close() may have run while `tabs()` was answering: take nothing after it.
        if (closed) return;
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
    void adapter.relink().catch(() => {});
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
      await adapter.stop().catch(() => {});
      leave();
      channel.postMessage({ left: tabId });
      channel.close();
    },
  };
}

/**
 * A ServiceWorker's global scope (its `self`), as `installProjectRouter` takes it: typed without
 * TypeScript's WebWorker lib, so that code importing cellb compiles with the DOM lib alone.
 */
export interface ServiceWorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: unknown;
  addEventListener(type: string, listener: (event: never) => unknown): void;
}

/**
 * The ServiceWorker side: webrun-http-browser's dispatcher, with the project as its key and the
 * tabs' shard workers as its handlers. What cellb adds: its urls (`<basePath><name>/`, a root
 * project, `http://cellb.internal/<name>/` for calls between shards), which shard a call goes to,
 * the page's cookies, no control headers from pages, and the host page.
 */
export function installProjectRouter(
  scope: ServiceWorkerScope,
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
): { dispatcher: SwHttpDispatcher } {
  const sw = scope as unknown as ServiceWorkerGlobalScope;
  const base = opts.basePath.endsWith("/") ? opts.basePath : `${opts.basePath}/`;
  const internal = new URL(INTERNAL_ORIGIN);

  /** Whether `url` goes to the root project (`opts.root`). */
  const atRoot = (url: URL) =>
    !!opts.root &&
    url.origin === sw.location.origin &&
    !url.pathname.startsWith(base) &&
    !(opts.root.passthrough ?? []).some((p) => url.pathname.startsWith(p));

  /**
   * `<base><name>/<rest>` → the project's name, the Worker's path `/<rest>`, and `<base><name>` as
   * the URL spells it (`prefix`: what `stripBase` cuts, so a name the URL leaves unescaped, `a@b`,
   * or escapes where it need not, `%61pp`, is cut as written).
   */
  const split = (url: URL): { name: string; path: string; prefix: string } | undefined => {
    if (opts.root && atRoot(url)) return { name: opts.root.name, path: url.pathname, prefix: "" };
    if (url.origin !== sw.location.origin || !url.pathname.startsWith(base)) return undefined;
    const rest = url.pathname.slice(base.length);
    const slash = rest.indexOf("/");
    const raw = slash < 0 ? rest : rest.slice(0, slash);
    const name = decodeURIComponent(raw);
    return name
      ? { name, path: slash < 0 ? "/" : rest.slice(slash), prefix: `${base}${raw}` }
      : undefined;
  };

  const isShard = (h: HandlerInfo) => typeof (h.meta as { shard?: unknown })?.shard === "number";
  let rr = 0;
  const dispatcher = new SwHttpDispatcher({
    self: sw,
    handleFetch: false,
    attachTimeoutMs: opts.attachTimeoutMs ?? 15_000,
    key: (url) => {
      // Calls between shards: http://cellb.internal/<name>/.
      if (url.host === internal.host) {
        const name = url.pathname.split("/")[1];
        return name ? decodeURIComponent(name) : undefined;
      }
      return split(url)?.name;
    },
    // A call between shards names its shard (it waits for that one); the rest go to the shard
    // with the fewest requests in flight, round robin among equals. The tabs' pages are handlers
    // of the key too (their adapters'), with nothing to serve: never picked.
    route: (request, _key, handlers) => {
      const shards = handlers.filter(isShard);
      const named = request.headers.get(H.shard);
      if (named !== null)
        return shards.find((h) => (h.meta as { shard: number }).shard === Number(named));
      if (!shards.length) return undefined;
      const start = rr++ % shards.length;
      let best = shards[start];
      for (let i = 1; i < shards.length; i++) {
        const h = shards[(start + i) % shards.length];
        if (h.inflight < best.inflight) best = h;
      }
      return best;
    },
    // A call between shards fails as an error its caller rethrows (postVia); a page's request
    // gets a response it can read.
    failure: (request, failure) => failed(request, failure),
    // Pages may not address objects or shards directly: no control headers on their sockets.
    socketHeaders: (headers, from) =>
      from === "page"
        ? headers?.filter(([name]) => !name.toLowerCase().startsWith("x-cellb"))
        : headers,
  });
  dispatcher.start();

  const failed = (request: Request, failure: DispatchFailure): Response => {
    const named = request.headers.get(H.shard);
    const what = named !== null ? `cell shard ${named}` : "the project";
    const error =
      failure.kind === "lost" && failure.error instanceof LinkLostError && named !== null
        ? new ShardOwnerLostError(Number(named))
        : failure.kind === "timeout"
          ? new Error(`${what} was not attached in time`)
          : failure.kind === "gone"
            ? new Error(`${what} has no tab running it`)
            : (failure.error as Error);
    if (request.headers.get(H.kind) !== null) return errorResponse(error, 503);
    return new Response(`cellb: ${(error as Error)?.message ?? error}`, { status: 503 });
  };

  const askForLinks = async (name: string) => {
    const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: NEED_LINKS, name });
  };

  /** Whether a tab runs project `name`'s shards, waiting up to `ms` for one to link. */
  const runningShards = async (name: string, ms: number): Promise<boolean> => {
    await dispatcher.ready;
    const live = () => dispatcher.table.live(name).some(isShard);
    if (live()) return true;
    void askForLinks(name);
    for (const until = Date.now() + ms; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100));
      if (live()) return true;
    }
    return false;
  };

  /** Headers for a request the router sends on: no control headers from the page, its base. */
  const routed = (req: Request, prefix: string, root: boolean): Headers => {
    // Headers only: a Request built from `req` would take its body.
    const headers = new Headers(req.headers);
    for (const h of Object.values(H)) if (h !== H.cookie) headers.delete(h);
    if (opts.stripBase && !root) headers.set(H.base, prefix);
    return headers;
  };

  /** A request to project `name`, with the page's cookies in and the Worker's out. */
  const serve = async (
    { name, prefix }: { name: string; prefix: string },
    req: Request,
    root: boolean,
  ): Promise<Response> => {
    try {
      // A project no tab has ever served is not the router's: the page's own request goes to the
      // network, as if there were no router (not the copy below, with the page's cookies in a
      // header and a streamed body).
      await dispatcher.ready;
      if (!dispatcher.serves(name)) return await fetch(req);
      const headers = await withPageCookies(
        sw,
        new Request(req.url, { headers: routed(req, prefix, root) }),
      );
      const res = await dispatcher.dispatch(
        new Request(req.url, {
          method: req.method,
          headers,
          body: req.body,
          signal: req.signal,
          duplex: "half",
        } as RequestInit),
      );
      return await applyWorkerCookies(sw, res);
    } catch (err) {
      // A response the page can read, instead of a network error with no cause.
      console.error(`cellb: ${req.method} ${new URL(req.url).pathname} failed:`, err);
      return new Response(`cellb: ${(err as Error)?.stack ?? err}`, { status: 502 });
    }
  };

  sw.addEventListener("fetch", (e: FetchEvent) => {
    const req = e.request;
    const url = new URL(req.url);
    const root = atRoot(url);
    if (!root && req.mode === "navigate") return; // the pages under basePath are the host's
    const project = split(url);
    if (!project) return;
    const hostPage = root && req.mode === "navigate" ? opts.root?.hostPage : undefined;
    if (hostPage)
      e.respondWith(
        runningShards(project.name, opts.root?.hostWaitMs ?? 2_000).then((running) =>
          running
            ? serve(project, req, root)
            : Response.redirect(
                `${new URL(hostPage, url.origin).href}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
                302,
              ),
        ),
      );
    else e.respondWith(serve(project, req, root));
  });

  // A page's socket (`serviceWorkerConnector`): routed as a fetch would be, without the page's
  // headers.
  sw.addEventListener("message", (e: ExtendableMessageEvent) => {
    const m = e.data;
    if (m?.type !== SOCKET) return;
    const reply = e.ports[0];
    e.waitUntil(
      (async () => {
        try {
          const url = new URL(m.url);
          const httpUrl = new URL(url);
          if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
          else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
          const project = split(httpUrl);
          if (!project) throw new Error(`not a project URL: ${m.url}`);
          const headers: [string, string][] = [];
          if (opts.stripBase && !atRoot(httpUrl)) headers.push([H.base, project.prefix]);
          const { port, protocol } = await dispatcher.connectWebSocket(
            `${httpUrl}`,
            m.protocols ?? [],
            headers,
          );
          reply.postMessage({ ok: true, port, protocol }, [port]);
        } catch (err) {
          reply.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
        }
      })(),
    );
  });

  return { dispatcher };
}
