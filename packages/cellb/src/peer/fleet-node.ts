import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import { celldBucket } from "../bucket/celld-cells.js";
import type { ObjectStore } from "../bucket/object-store.js";
import { s3ObjectStore } from "../bucket/s3-object-store.js";
import type { ContainerEngine } from "../container.js";
import type { CellRuntime } from "../core/runtime.js";
import { loadNodeProject } from "../project/node-project.js";
import { withUpgrade } from "../ws/upgrade.js";
import { bridgeUpgrade, celldPeers, startCelldPeerServer } from "./celld-peer.js";
import { createLogFollower } from "./log-follower.js";
import { createLogLeader } from "./log-leader.js";
import { createLogRecoverer } from "./log-recoverer.js";

/**
 * A cellb node in a celld fleet, as `celld --bucket …` runs one: the project's Worker on a
 * public HTTP listener, its cells in the fleet bucket under celld's ownership records, and
 * celld's peer tunnel on an internal listener, so celld nodes and other cellb nodes route a
 * cell's requests to whichever node owns it, and this node routes to them.
 */
export interface FleetNodeOptions {
  /** The wrangler project. */
  dir: string;
  /** The fleet bucket on S3 (`s3://NAME[/PREFIX]`), parsed. Or give `store`. */
  bucket?: { name: string; prefix: string };
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Instead of `bucket`: any ObjectStore (tests, a celld dev `objects.sqlite3`). */
  store?: ObjectStore;
  /** This node's name in the fleet (default `cellb-<random>`, as celld names its nodes). */
  node?: string;
  /** Public Worker listener, IP:PORT (default 127.0.0.1:8080; port 0: any free port). */
  listen?: string;
  /** Peer listener, IP:PORT (default 127.0.0.1:0). */
  internalListen?: string;
  /** The address peers dial, when it differs from the internal listener's. */
  advertise?: string;
  /** The node lease (default 10 s, celld's). */
  leaseTtlMs?: number;
  /**
   * A directory for the cells' local SQLite files (default: memory; the bucket is the copy) and
   * the log-tier segments this node holds for celld leaders (default: a directory of its own under
   * the OS temp dir). Give one on a disk that survives a restart.
   */
  data?: string;
  /** On close, how long requests in flight may take to finish (default 5 s). */
  drainMs?: number;
  /**
   * celld's CELLD_DURABILITY: "fleet" (default, as celld) leads a log tier session, so commits
   * are acknowledged once followers hold them; "bucket" acknowledges on the bucket alone.
   */
  durability?: "fleet" | "bucket";
  /**
   * The engine that runs the project's `containers` classes (their images under
   * `cellb.containers`; Wasmer or Lifo from @statewalker/cellb-containers). A cell's container
   * runs on the node that owns the cell: when the cell moves, the next owner's engine starts the
   * same image. Without one, those classes are reported in `unsupported`.
   */
  containers?: ContainerEngine;
}

export interface FleetNode {
  node: string;
  /** `http://host:port` of the public listener. */
  url: string;
  /** The peer address in the node record. */
  addr: string;
  runtime: CellRuntime;
  unsupported: string[];
  /** Stops listening, releases every cell and deletes the node record. Idempotent. */
  close(): Promise<void>;
}

/** How long a leaving node keeps its open connections for requests already sent on them. */
const LINGER_MS = 500;

const hostPort = (s: string, what: string): [string, number] => {
  const i = s.lastIndexOf(":");
  const port = Number(s.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`${what} must be IP:PORT, got ${JSON.stringify(s)}`);
  return [s.slice(0, i).replace(/^\[|\]$/g, ""), port];
};

export async function startFleetNode(o: FleetNodeOptions): Promise<FleetNode> {
  const node = o.node ?? `cellb-${randomBytes(6).toString("hex")}`;
  const s3 = () => {
    if (!o.bucket) throw new Error("startFleetNode needs `bucket` or `store`");
    if (!o.credentials) throw new Error("an S3 bucket needs credentials");
    return s3ObjectStore({
      endpoint: o.endpoint ?? `https://s3.${o.region ?? "us-east-1"}.amazonaws.com`,
      bucket: o.bucket.name,
      prefix: o.bucket.prefix,
      region: o.region ?? "us-east-1",
      ...o.credentials,
    });
  };
  // The bucket's close() closes its store: it gets one of its own.
  const store = o.store ?? s3();
  // celld's log tier: this node leads a session (its commits acknowledged by followers) unless
  // durability is "bucket", recovers dead leaders' sessions, and follows other leaders.
  const fleetDurability = (o.durability ?? "fleet") === "fleet";
  let leader: ReturnType<typeof createLogLeader> | undefined;
  const recoverer = createLogRecoverer({ store: o.store ?? s3(), node });
  const bucket = celldBucket(o.store ?? s3(), {
    node,
    leaseTtlMs: o.leaseTtlMs,
    // a predecessor under our name that died leading a session: recovered before we start
    recoverPredecessor: async () => {
      await recoverer.recover(node);
    },
    // a dead owner's session, recovered at the takeover of one of its cells (celld does so)
    recoverDead: (dead) => recoverer.recover(dead),
    onLogLost: () => leader?.lost(),
  });
  const project = await loadNodeProject(o.dir, {
    openSql: nodeSqliteOpener(o.data, { pageCapture: true }),
    files: new MemFilesApi(),
    storage: bucket,
    peers: celldPeers({ store, node }),
    containers: o.containers,
  });
  const { runtime } = project;
  const [peerHost, peerPort] = hostPort(o.internalListen ?? "127.0.0.1:0", "--internal-listen");
  // celld's log tier recruits this node as a follower: the segments it holds go to disk here.
  const followerDir = o.data ?? join(tmpdir(), `cellb-follower-${node}`);
  const follower = createLogFollower({ dir: followerDir, store, node });
  const followerGc = setInterval(() => void follower.gc().catch(() => {}), 600_000);
  followerGc.unref();
  const peer = await startCelldPeerServer({
    runtime,
    store,
    node,
    host: peerHost,
    port: peerPort,
    probe: (c) => bucket.probe(c),
    follower,
  });
  const addr = o.advertise ?? peer.addr;
  await bucket.advertise(addr);
  recoverer.start();
  if (fleetDurability) {
    leader = createLogLeader({ bucket, store, node });
    bucket.setShipper(leader.shipper);
    leader.start();
  }

  const toRequest = async (req: IncomingMessage, body?: Uint8Array) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: body as BodyInit | undefined,
    });
  };
  let inFlight = 0;
  let drained: (() => void) | undefined;
  let leaving = false;
  const server: Server = createServer(async (req, res) => {
    inFlight++;
    // Leaving: answered, and the client told not to send more on this connection.
    if (leaving) res.setHeader("connection", "close");
    res.once("close", () => {
      if (--inFlight === 0) drained?.();
    });
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const chunks: Buffer[] = [];
      // Read whole: a stream the handler cancels unread can crash Node's adapter.
      if (hasBody) for await (const c of req) chunks.push(c as Buffer);
      const r = await runtime.fetch(
        await toRequest(req, hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined),
      );
      const out: Record<string, string | string[]> = {};
      r.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "transfer-encoding" && k !== "set-cookie") out[k] = v;
      });
      const cookies = r.headers.getSetCookie?.() ?? [];
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(r.status, out);
      if (r.body) for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String((e as Error)?.message ?? e));
    }
  });
  server.keepAliveTimeout = 65_000;
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });
  // Upgraded sockets hold server.close() open and closeAllConnections() does not reach them.
  const upgraded = new Set<Duplex>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    const fail = (status: number, body: string) =>
      socket.end(
        `HTTP/1.1 ${status} Error\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    if (String(req.headers.upgrade).toLowerCase() !== "websocket")
      return fail(400, "only WebSocket upgrades are served");
    const protocols = req.headers["sec-websocket-protocol"] as string | undefined;
    void bridgeUpgrade(
      wss,
      req,
      socket,
      head,
      async () =>
        runtime.fetch(
          withUpgrade(
            await toRequest(req),
            "websocket",
            protocols ? { "Sec-WebSocket-Protocol": protocols } : undefined,
          ),
        ),
      (e) => fail(500, String((e as Error)?.message ?? e)),
      fail,
    );
  });
  const [host, port] = hostPort(o.listen ?? "127.0.0.1:8080", "--listen");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const bound = (server.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  return {
    node,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${bound}`,
    addr,
    runtime,
    unsupported: project.unsupported ?? [],
    close: () =>
      (closing ??= (async () => {
        // A graceful leave, as celld's hand-off: no new connections; requests in flight finish
        // (for at most the grace period); then the cells are released while the peer server
        // still answers, so a request routed here meanwhile is told to re-resolve the owner
        // (stale-owner) instead of finding no one; then the peer server stops.
        // A request a client sent on a kept-alive connection just before the leave began is still
        // on its way: the open connections stay a moment (http.Server's close() would drop the
        // idle ones at once, resetting it), and every answer meanwhile closes its connection.
        leaving = true;
        const listening = new Promise<void>((r) =>
          NetServer.prototype.close.call(server, () => r()),
        );
        if (sockets.size > 0)
          await new Promise((r) => setTimeout(r, Math.min(LINGER_MS, o.drainMs ?? 5_000)));
        server.closeIdleConnections?.();
        if (inFlight > 0)
          await new Promise<void>((r) => {
            drained = r;
            setTimeout(r, o.drainMs ?? 5_000).unref?.();
          });
        server.closeAllConnections?.();
        for (const c of wss.clients) c.terminate();
        for (const u of upgraded) u.destroy();
        await listening;
        // releases every owned cell (own.json → released) and deletes the node record
        // no more shipping; the session sealed once the bucket holds what it shipped
        await leader?.close();
        await runtime.close();
        recoverer.close();
        await peer.close();
        clearInterval(followerGc);
      })()),
  };
}

export interface ServeArgs {
  dir: string;
  bucket: { name: string; prefix: string };
  endpoint?: string;
  region: string;
  listen: string;
  internalListen?: string;
  advertise?: string;
  node?: string;
  leaseTtlMs?: number;
  data?: string;
  durability?: "fleet" | "bucket";
  /** `--containers MODULE` (CELLB_CONTAINERS): a module whose default export makes the engine. */
  containers?: string;
}

/**
 * `cellb serve [PROJECT] --bucket s3://NAME[/PREFIX] [--endpoint URL] [--region R]
 * [--listen IP:PORT] [--internal-listen IP:PORT] [--advertise ADDR:PORT] [--node NAME]
 * [--lease-ttl MS] [--data DIR]`, with celld's environment variables as defaults (CELLD_BUCKET,
 * S3_ENDPOINT, AWS_REGION / AWS_DEFAULT_REGION).
 */
export function parseServeArgs(args: string[], env: Record<string, string | undefined>): ServeArgs {
  const flags: Record<string, string> = {};
  const names = [
    "bucket",
    "endpoint",
    "region",
    "listen",
    "internal-listen",
    "advertise",
    "node",
    "lease-ttl",
    "data",
    "durability",
    "containers",
  ];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (!names.includes(k)) throw new Error(`unknown option --${k}`);
      const v = inline ?? args[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      flags[k] = v;
    } else if (dir === undefined) dir = a;
    else throw new Error("one project directory only");
  }
  const url = flags.bucket ?? env.CELLD_BUCKET;
  if (!url) throw new Error("--bucket s3://NAME[/PREFIX] (or CELLD_BUCKET) is required");
  const m = /^(?:([a-z0-9]+):\/\/)?([^/]+)(?:\/(.*))?$/.exec(url);
  if (!m || (m[1] && m[1] !== "s3"))
    throw new Error(`cellb serve supports s3:// buckets only, got ${JSON.stringify(url)}`);
  const out: ServeArgs = {
    dir: dir ?? ".",
    bucket: { name: m[2], prefix: (m[3] ?? "").replace(/\/+$/, "") },
    endpoint: flags.endpoint ?? env.S3_ENDPOINT,
    region: flags.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    listen: flags.listen ?? "127.0.0.1:8080",
  };
  if (flags["internal-listen"]) out.internalListen = flags["internal-listen"];
  if (flags.advertise) out.advertise = flags.advertise;
  if (flags.node) out.node = flags.node;
  if (flags["lease-ttl"]) out.leaseTtlMs = Number(flags["lease-ttl"]);
  if (flags.data) out.data = flags.data;
  const durability = flags.durability ?? env.CELLD_DURABILITY;
  if (durability !== undefined) {
    if (durability !== "fleet" && durability !== "bucket")
      throw new Error(`--durability must be fleet or bucket, got ${JSON.stringify(durability)}`);
    out.durability = durability;
  }
  const containers = flags.containers ?? env.CELLB_CONTAINERS;
  if (containers) out.containers = containers;
  if (out.endpoint === undefined) delete out.endpoint;
  return out;
}

/**
 * The container engine of `--containers MODULE`: the module's default export, an engine or a
 * function (async or not) that makes one. A path (relative to `cwd`) or a package name.
 */
export async function loadContainerEngine(
  spec: string,
  cwd = process.cwd(),
): Promise<ContainerEngine> {
  const url =
    spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(cwd, spec)).href : spec;
  const m = (await import(url)) as { default?: unknown };
  const made = typeof m.default === "function" ? await (m.default as () => unknown)() : m.default;
  const engine = made as ContainerEngine | undefined;
  if (!engine || typeof engine.start !== "function" || typeof engine.close !== "function")
    throw new Error(
      `--containers ${spec}: its default export must be a container engine or a function that makes one`,
    );
  return engine;
}
