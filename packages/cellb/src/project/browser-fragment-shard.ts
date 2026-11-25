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
import type { CellRuntimeOptions } from "../core/runtime.js";
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
import { hostOf, linkTo, remoteBase } from "./fragment-routes.js";
import type { ServicePlacement, ServiceResolver } from "./service-bindings.js";

const CLOSE = "cellb:shard-close";
/** The Durable Object binding taken as a fragment DO when the fragment names none. */
const FRAGMENT_BINDING = "FRAGMENT";

interface Loaded {
  host: Awaited<ReturnType<typeof browserProjectRuntime>>;
  handler: (req: Request) => Promise<Response>;
  entry: string;
  /** Where its cells are: the shard that owns one, or undefined for this one. */
  route: NonNullable<CellRuntimeOptions["route"]>;
}

const unavailable = (reason: string): ServicePlacement => ({ kind: "unavailable", reason });

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

  /**
   * Where the service bindings of fragment `caller` find `service` (#192), at each call: the
   * target's fragment DO decides. On this shard, JS RPC in the runtime; on another, a request
   * through the router (a MessagePort); on another host by the route table, HTTP.
   */
  const servicesOf =
    (caller: string): ServiceResolver =>
    (service) => {
      if (closing || !fragments.has(caller))
        return unavailable(`the calling fragment "${caller}" is not active`);
      const host = hostOf(init?.routes, service);
      if (host !== "local") {
        const base = remoteBase(host, service, init?.peers);
        return base
          ? { kind: "link", send: linkTo(base, (r) => fetch(r)) }
          : unavailable(`fragment "${service}" is at ${host}, and this host has no way there`);
      }
      const target = fragments.get(service);
      if (!target) return unavailable(`no fragment "${service}" is active in this shard`);
      const ns = target.host.runtime.env[target.entry] as DurableObjectNamespace;
      const id = ns.idFromName(service);
      const className = target.host.runtime.durableObjectBindings[target.entry];
      const send = target.route(`${className}/${id}`, id);
      return send ? { kind: "link", send } : { kind: "runtime", runtime: target.host.runtime };
    };

  async function add(msg: FragmentShardAdd): Promise<string[]> {
    if (!init) throw new Error("the shard is not started");
    if (closing) throw new Error("the shard is closing");
    if (fragments.has(msg.id)) return fragments.get(msg.id)?.host.unsupported ?? [];
    const entry = entryOf(msg);
    const route = throughRouter(
      init,
      serviceReady,
      `${INTERNAL_ORIGIN}/${FRAGMENTS_KEY}/${encodeURIComponent(msg.id)}/`,
    );
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
      route,
      services: servicesOf(msg.id),
    });
    // Closed while it loaded: it never serves here.
    if (closing) {
      await host.close().catch(() => {});
      throw new Error("the shard is closing");
    }
    fragments.set(msg.id, {
      host,
      entry,
      route,
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
  // A close does not wait in line: a load that never ends must not keep the shard (and its lock)
  // from the next tab. It refuses what is queued, and a load that finishes after it closes itself.
  let queue: Promise<void> = Promise.resolve();
  let closing = false;
  scope.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: string } | undefined;
    if (![FRAGMENT_SHARD_INIT, FRAGMENT_ADD, FRAGMENT_REMOVE, CLOSE].includes(data?.type ?? ""))
      return;
    if (data?.type === CLOSE) {
      closing = true;
      void handle(e, data);
      return;
    }
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
