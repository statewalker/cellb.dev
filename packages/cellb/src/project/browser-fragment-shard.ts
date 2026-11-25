/**
 * A shard worker of the fragment host in a browser (#191; statewalker-root ADR
 * 2026-11-21-fragment-host-and-routing): one worker of the pool the origin's tabs share
 * (`joinFragmentShards`), running every enabled fragment's project side by side, each in a
 * namespace of its own (its OPFS pool and files directory, keyed by the fragment's id).
 *
 *   ServiceWorker:  installProjectRouter(self, { basePath: "/" })   // <base>fragments/<id>/…
 *   each page:      joinFragmentShards({ shards, spawn, serviceWorker, basePath: "/" })
 *   shard worker:   serveFragmentShard({ sqlite3 })
 *
 * A page's request `<prefix><id>/<path>` reaches fragment `id`'s fragment DO, the object at
 * `idFromName(<id>)` of its entry binding, at `/<path>`; the stub's call runs in the shard that
 * owns the object, through the router as any call between shards. A call between shards,
 * `http://cellb.internal/fragments/<id>/…`, reaches that fragment's cells. Fragments share the
 * worker's realm: they are trusted, and each project's bundle reads its own `cloudflare:workers`
 * scope.
 */
import { serveHttpInWorker, type WorkerHttpService } from "@statewalker/webrun-http-browser/sw";
import type { DurableObjectNamespace } from "../core/namespace.js";
import { cellsHttpHandler, servePageRequest } from "../transport/cells-http.js";
import { CfWebSocket } from "../ws/server.js";
import { carryWebSocketHeaders } from "../ws/upgrade.js";
import { browserProjectRuntime } from "./browser-host.js";
import { throughRouter, upgradeOverPort } from "./browser-shards.js";
import {
  FRAGMENT_ADD,
  FRAGMENT_REMOVE,
  FRAGMENT_SHARD_INIT,
  FRAGMENTS_KEY,
  type FragmentShardAdd,
  type FragmentShardInit,
  INTERNAL_ORIGIN,
} from "./browser-tab-protocol.js";

const CLOSE = "cellb:shard-close";
/** The Durable Object binding taken as a fragment DO when the fragment names none. */
const FRAGMENT_BINDING = "FRAGMENT";

interface Loaded {
  host: Awaited<ReturnType<typeof browserProjectRuntime>>;
  handler: (req: Request) => Promise<Response>;
  entry: string;
}

const text = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain" } });

/** `<id>/<rest>` after a prefix → the fragment id and the path `/<rest>`; undefined if malformed. */
function split(rest: string): { id: string; path: string } | undefined {
  const slash = rest.indexOf("/");
  try {
    const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
    return id ? { id, path: slash < 0 ? "/" : rest.slice(slash) } : undefined;
  } catch {
    return undefined;
  }
}

/** The fragment's entry: `entry`, or its FRAGMENT binding, or its only Durable Object binding. */
function entryOf(add: FragmentShardAdd): string {
  const names = (add.config.durable_objects?.bindings ?? []).map((b) => b.name);
  const chosen =
    add.entry ??
    (names.includes(FRAGMENT_BINDING)
      ? FRAGMENT_BINDING
      : names.length === 1
        ? names[0]
        : undefined);
  if (!chosen || !names.includes(chosen))
    throw new Error(
      add.entry
        ? `"${add.id}": no Durable Object binding "${add.entry}"`
        : `"${add.id}": no fragment DO: name its binding ${FRAGMENT_BINDING}, or give its entry`,
    );
  return chosen;
}

/** The worker side of the fragment host's shard pool: call it in the shard worker's script. */
export function serveFragmentShard(opts: {
  /** An initialized SQLite WASM module, or a function that makes one. */
  sqlite3: unknown | (() => Promise<unknown>);
  /** `browserProjectRuntime`'s `isolateScript`. */
  isolateScript?: URL;
}): void {
  const scope = globalThis as unknown as {
    addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  };
  const internalHost = new URL(INTERNAL_ORIGIN).host;
  const fragments = new Map<string, Loaded>();
  let init: FragmentShardInit | undefined;
  let service: WorkerHttpService | undefined;
  let ready!: (s: WorkerHttpService) => void;
  const serviceReady = new Promise<WorkerHttpService>((r) => (ready = r));
  let sqlite: Promise<unknown> | undefined;
  const sqlite3 = () =>
    (sqlite ??=
      typeof opts.sqlite3 === "function"
        ? (opts.sqlite3 as () => Promise<unknown>)()
        : Promise.resolve(opts.sqlite3));

  /** One request from the router: a page's, to a fragment DO, or a call between shards. */
  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.host === internalHost) {
      const at = url.pathname.slice(`/${FRAGMENTS_KEY}/`.length);
      const target = url.pathname.startsWith(`/${FRAGMENTS_KEY}/`) ? split(at) : undefined;
      const loaded = target && fragments.get(target.id);
      if (!loaded) return text(503, `cellb: no fragment "${target?.id ?? ""}" in this shard`);
      return upgradeOverPort(await loaded.handler(req));
    }
    const prefix = init?.prefix ?? `/${FRAGMENTS_KEY}/`;
    const target = url.pathname.startsWith(prefix)
      ? split(url.pathname.slice(prefix.length))
      : undefined;
    const loaded = target && fragments.get(target.id);
    if (!target || !loaded) return text(404, `no fragment "${target?.id ?? ""}" on this host`);
    const forwarded = new URL(target.path, url);
    forwarded.search = url.search;
    const ns = loaded.host.runtime.env[loaded.entry] as DurableObjectNamespace;
    const stub = ns.get(ns.idFromName(target.id));
    // As a project's Worker gets a page's request: its cookies in, its Set-Cookie out, no control
    // headers; its Cookie and a socket's upgrade carried onto the rebuilt request (a browser
    // drops them from every Request it builds).
    return upgradeOverPort(
      await servePageRequest(req, (inner) =>
        stub.fetch(carryWebSocketHeaders(inner.headers, new Request(forwarded, inner))),
      ),
    );
  }

  async function add(msg: FragmentShardAdd): Promise<string[]> {
    if (!init) throw new Error("the shard is not started");
    if (fragments.has(msg.id)) return fragments.get(msg.id)?.host.unsupported ?? [];
    const entry = entryOf(msg);
    const host = await browserProjectRuntime({
      config: msg.config,
      code: msg.code,
      assetFiles: msg.assetFiles,
      ai: msg.ai,
      sqlite3: await sqlite3(),
      // Its own namespace: a pool and a files directory of its own, in every shard.
      pool: `${FRAGMENTS_KEY}-${msg.id}-shard-${init.shard}`,
      filesDir: `${FRAGMENTS_KEY}-${msg.id}-files-${init.shard}`,
      isolateScript: opts.isolateScript,
      ownDatabasesScope: init.shards > 1 ? `s${init.shard}` : undefined,
      route: throughRouter(
        init,
        serviceReady,
        `${INTERNAL_ORIGIN}/${FRAGMENTS_KEY}/${encodeURIComponent(msg.id)}/`,
      ),
    });
    fragments.set(msg.id, {
      host,
      entry,
      handler: cellsHttpHandler(host.runtime, { passUpgrades: true }),
    });
    return host.unsupported;
  }

  async function remove(id: string): Promise<void> {
    const loaded = fragments.get(id);
    if (!loaded) return;
    // Unrouted first, so no new request reaches it while it closes.
    fragments.delete(id);
    await loaded.host.close();
  }

  // One message at a time: loading a fragment sets the realm's `cloudflare:workers` scope and
  // then imports its bundle, so two loads at once would give the second's scope to the first
  // (its module `env` would be another fragment's). Removals wait for the loads before them.
  let queue: Promise<void> = Promise.resolve();
  scope.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: string } | undefined;
    if (![FRAGMENT_SHARD_INIT, FRAGMENT_ADD, FRAGMENT_REMOVE, CLOSE].includes(data?.type ?? ""))
      return;
    queue = queue.then(() => handle(e, data));
  });

  async function handle(e: MessageEvent, data: { type?: string } | undefined): Promise<void> {
    const reply = e.ports[0] as MessagePort;
    try {
      if (data?.type === FRAGMENT_SHARD_INIT) {
        init = data as FragmentShardInit;
        service = serveHttpInWorker(serve);
        ready(service);
        return reply.postMessage({ ok: true });
      }
      if (data?.type === FRAGMENT_ADD) {
        const unsupported = await add(data as FragmentShardAdd);
        return reply.postMessage({ ok: true, unsupported });
      }
      if (data?.type === FRAGMENT_REMOVE) {
        await remove((data as { id: string }).id);
        return reply.postMessage({ ok: true });
      }
      // Closing: the cells move elsewhere, their sockets' clients reconnect there now.
      try {
        CfWebSocket.goAway();
        for (const id of [...fragments.keys()]) await remove(id);
      } finally {
        await service?.close().catch(() => {});
        service = undefined;
      }
      reply.postMessage({ ok: true });
    } catch (err) {
      reply.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  }
}
