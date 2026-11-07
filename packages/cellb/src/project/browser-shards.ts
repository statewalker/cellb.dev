/**
 * One project in several browser workers, so that its cells run in parallel threads. Each worker
 * hosts the project with `browserProjectRuntime` and its own OPFS pool, owns the cells that
 * `shardOf(id, shards)` gives it, and reaches every other cell through the worker that owns it
 * over a MessagePort. Any worker takes ingress; the page spreads requests over them.
 *
 *   page:    startProjectShards({ shards, spawn, config, code, name })  → { fetch, close }
 *   worker:  serveProjectShard({ sqlite3 })
 *
 * Placement is fixed by the cell id (no rebalancing), and a closed page takes its workers along:
 * for cells that must outlive a tab, use a fleet bucket (`bucket`), as for one worker.
 */
import {
  serveHttpInWorker,
  type WorkerHttpService,
  webSocketUpgradeResponse,
} from "@statewalker/webrun-http-browser/worker";
import { withUrl } from "../core/request-body.js";
import type { CellRuntimeOptions } from "../core/runtime.js";
import { shardOf } from "../core/shard.js";
import { cellsHttpHandler, type RemoteRuntime } from "../transport/cells-http.js";
import { H, keepUpgrade } from "../transport/cells-link.js";
import { connectRuntime, linkOverPort, serveRuntime } from "../transport/port.js";
import { CellsResponse, CfWebSocket, takeClientPort } from "../ws/server.js";
import {
  type BrowserBucket,
  type BrowserProjectOptions,
  browserProjectRuntime,
} from "./browser-host.js";

const INIT = "cellb:shard";
const CLOSE = "cellb:shard-close";
/**
 * A shard of a project shared by the tabs of an origin (`joinProjectShards`): it serves through
 * the ServiceWorker's router (webrun-http-browser's `serveHttpInWorker`), which the tab attaches
 * it to, and reaches the other shards through it.
 */
export const TAB_INIT = "cellb:tab-shard";
/** The host calls between shards go to through the router: `http://cellb.internal/<project>/`. */
export const INTERNAL_ORIGIN = "http://cellb.internal";

/** What a shard worker shared by tabs is told: no peers, it reaches them through the router. */
export interface TabShardInit {
  type: typeof TAB_INIT;
  name: string;
  shard: number;
  shards: number;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding. */
  ai?: BrowserProjectOptions["ai"];
  bucket?: BrowserBucket;
  pool: string;
  filesDir: string;
}

/** What a shard worker is told (the ports travel next to it). */
interface ShardInit {
  type: typeof INIT;
  shard: number;
  shards: number;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding. */
  ai?: BrowserProjectOptions["ai"];
  bucket?: BrowserBucket;
  pool: string;
  filesDir: string;
  /** For ports[2..]: the shard each port links to (`link`) or is served to (`serve`). */
  peers: { shard: number; role: "link" | "serve" }[];
}

/**
 * The worker side: hosts one shard when a page says so — of `startProjectShards` (peers wired
 * directly) or of `joinProjectShards` (shared by the tabs, linked to the ServiceWorker's router).
 * Messages of other types are left to the worker's own listeners.
 */
export function serveProjectShard(opts: {
  /** An initialized SQLite WASM module, or a function that makes one. */
  sqlite3: unknown | (() => Promise<unknown>);
  /** `browserProjectRuntime`'s `isolateScript`. */
  isolateScript?: URL;
}): void {
  const scope = globalThis as unknown as {
    addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
    postMessage(message: unknown): void;
  };
  let host: Awaited<ReturnType<typeof browserProjectRuntime>> | undefined;
  let service: WorkerHttpService | undefined;
  const sqlite3 = () =>
    typeof opts.sqlite3 === "function"
      ? (opts.sqlite3 as () => Promise<unknown>)()
      : Promise.resolve(opts.sqlite3);
  scope.addEventListener("message", async (e: MessageEvent) => {
    const type = (e.data as { type?: string } | undefined)?.type;
    if (![INIT, CLOSE, TAB_INIT].includes(type as string)) return;
    const reply = e.ports[0] as MessagePort;
    try {
      if (type === CLOSE) {
        try {
          // The cells move elsewhere: their sockets' clients reconnect there now.
          CfWebSocket.goAway();
          await host?.close();
        } finally {
          host = undefined;
          // The router sees this shard's owner gone (its owner lock), even if closing failed.
          await service?.close().catch(() => {});
          service = undefined;
        }
        return reply.postMessage({ ok: true });
      }
      if (type === TAB_INIT) {
        const init = e.data as TabShardInit;
        let ready!: (s: WorkerHttpService) => void;
        const serviceReady = new Promise<WorkerHttpService>((r) => (ready = r));
        host = await browserProjectRuntime({
          config: init.config,
          code: init.code,
          assetFiles: init.assetFiles,
          ai: init.ai,
          bucket: init.bucket,
          sqlite3: await sqlite3(),
          pool: init.pool,
          filesDir: init.filesDir,
          isolateScript: opts.isolateScript,
          route: throughRouter(init, serviceReady),
        });
        // Served through the ServiceWorker's router, which the tab attaches this worker to. The
        // package keeps the link: an owner lock the router watches, re-linking after a restart,
        // keep-alive while calls are in flight.
        const handler = cellsHttpHandler(host.runtime, { passUpgrades: true });
        service = serveHttpInWorker(async (req) => upgradeOverPort(await handler(req)));
        ready(service);
        return reply.postMessage({ ok: true, unsupported: host.unsupported });
      }
      const init = e.data as ShardInit;
      const links = new Map<number, (req: Request) => Promise<Response>>();
      const served: MessagePort[] = [e.ports[1] as MessagePort]; // ingress from the page
      for (const [i, peer] of init.peers.entries()) {
        const port = e.ports[i + 2] as MessagePort;
        if (peer.role === "link") links.set(peer.shard, (await linkOverPort(port)).send);
        else served.push(port);
      }
      host = await browserProjectRuntime({
        config: init.config,
        code: init.code,
        assetFiles: init.assetFiles,
        ai: init.ai,
        bucket: init.bucket,
        sqlite3: await sqlite3(),
        pool: init.pool,
        filesDir: init.filesDir,
        isolateScript: opts.isolateScript,
        route: (_key, id) => {
          const owner = shardOf(id.toString(), init.shards);
          return owner === init.shard ? undefined : links.get(owner);
        },
      });
      for (const port of served) await serveRuntime(port, host.runtime);
      reply.postMessage({ ok: true, unsupported: host.unsupported });
    } catch (err) {
      reply.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  });
}

/**
 * A 101 with a Workers WebSocket, as the ServiceWorker's router hands sockets over: the client
 * end's port in webrun-http-browser's 101.
 */
function upgradeOverPort(res: Response): Response {
  const ws = (res as Response & { webSocket?: CfWebSocket | null }).webSocket;
  if (res.status !== 101 || !ws) return res;
  return webSocketUpgradeResponse(
    takeClientPort(ws),
    res.headers.get("Sec-WebSocket-Protocol") ?? "",
  );
}

/**
 * The cells of other shards, through the ServiceWorker's router: a call goes to
 * `http://cellb.internal/<project>/` (the router's key for the project) naming its shard, with the
 * url it was made with in `H.url`; a socket opens through the router the same way.
 */
function throughRouter(
  init: { name: string; shard: number; shards: number },
  service: Promise<WorkerHttpService>,
): NonNullable<CellRuntimeOptions["route"]> {
  const target = `${INTERNAL_ORIGIN}/${encodeURIComponent(init.name)}/`;
  return (_key, id) => {
    const owner = shardOf(id.toString(), init.shards);
    if (owner === init.shard) return undefined;
    // `postVia` (the runtime's) adds the scheme header and rethrows error responses.
    return async (req) => {
      const svc = await service;
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        const headers: [string, string][] = [];
        for (const [k, v] of req.headers) if (k.startsWith("x-cellb")) headers.push([k, v]);
        headers.push([H.shard, String(owner)], [H.url, req.url]);
        const { port, protocol } = await svc.connectWebSocket(target, protocols, headers);
        return new CellsResponse(null, {
          status: 101,
          webSocket: new CfWebSocket(port),
          headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
        });
      }
      const moved = await withUrl(req, target);
      const headers = new Headers(req.headers);
      headers.set(H.shard, String(owner));
      headers.set(H.url, req.url);
      try {
        return await svc.fetch(keepUpgrade(req, new Request(moved, { headers })));
      } catch (err) {
        // The words Worker code has always seen for it (CellRouter's).
        if (err instanceof Error && err.name === "LinkLostError")
          throw new Error(
            "The router was lost while this call was in flight; it may or may not have been applied",
          );
        throw err;
      }
    };
  };
}

export interface ProjectShards {
  /** Ingress: a request to the project's Worker, in the next shard (round robin). */
  fetch(req: Request): Promise<Response>;
  /** The shards' runtimes, by shard number. */
  readonly shards: RemoteRuntime[];
  /** Configuration entries the runtime does not support (as `browserProjectRuntime` reports). */
  readonly unsupported: string[];
  /** Closes every shard's runtime (releasing bucket leases), then its worker. */
  close(): Promise<void>;
}

/** The page side: starts `shards` workers that each run `serveProjectShard`, wired together. */
export async function startProjectShards(opts: {
  shards: number;
  /** Starts one worker whose script calls `serveProjectShard`. */
  spawn: (shard: number) => Worker;
  config: BrowserProjectOptions["config"];
  code: BrowserProjectOptions["code"];
  assetFiles?: BrowserProjectOptions["assetFiles"];
  /** The OpenAI-compatible endpoint behind the project's `ai` binding. */
  ai?: BrowserProjectOptions["ai"];
  /** Each shard is its own fleet node, named `<node>-s<shard>`. */
  bucket?: BrowserBucket;
  /** Prefix of the shards' OPFS pools and files directories (`<name>-<shard>`). */
  name: string;
}): Promise<ProjectShards> {
  const workers = Array.from({ length: opts.shards }, (_, i) => opts.spawn(i));
  const ask = (w: Worker, data: unknown, ports: MessagePort[] = []) =>
    new Promise<{ ok: boolean; error?: string; unsupported?: string[] }>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (e) => {
        port1.close();
        resolve(e.data);
      };
      w.postMessage(data, [port2, ...ports]);
    });
  // A channel between every two shards: one end links (sends to), the other is served.
  const wiring = workers.map(() => ({
    peers: [] as ShardInit["peers"],
    ports: [] as MessagePort[],
  }));
  for (let i = 0; i < opts.shards; i++)
    for (let j = 0; j < opts.shards; j++) {
      if (i === j) continue;
      const { port1, port2 } = new MessageChannel();
      wiring[i].peers.push({ shard: j, role: "link" });
      wiring[i].ports.push(port1);
      wiring[j].peers.push({ shard: i, role: "serve" });
      wiring[j].ports.push(port2);
    }
  const ingress = workers.map(() => new MessageChannel());
  try {
    const started = await Promise.all(
      workers.map((w, i) =>
        ask(
          w,
          {
            type: INIT,
            shard: i,
            shards: opts.shards,
            config: opts.config,
            code: opts.code,
            assetFiles: opts.assetFiles,
            ai: opts.ai,
            bucket: opts.bucket && { ...opts.bucket, node: `${opts.bucket.node}-s${i}` },
            pool: `${opts.name}-${i}`,
            filesDir: `${opts.name}-files-${i}`,
            peers: wiring[i].peers,
          } satisfies ShardInit,
          [ingress[i].port2, ...wiring[i].ports],
        ),
      ),
    );
    const failed = started.find((r) => !r.ok);
    if (failed) throw new Error(`a project shard did not start: ${failed.error}`);
    const remotes = await Promise.all(ingress.map((c) => connectRuntime(c.port1)));
    let next = 0;
    return {
      fetch: (req) => remotes[next++ % remotes.length].fetch(req),
      shards: remotes,
      unsupported: started[0].unsupported ?? [],
      async close() {
        await Promise.all(remotes.map((r) => r.close()));
        await Promise.all(workers.map((w) => ask(w, { type: CLOSE })));
        for (const w of workers) w.terminate();
      },
    };
  } catch (err) {
    for (const w of workers) w.terminate();
    throw err;
  }
}
