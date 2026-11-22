import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { nodeSqliteOpener } from "../adapters/node-sqlite.js";
import { celldBucket } from "../bucket/celld-cells.js";
import type { ObjectStore } from "../bucket/object-store.js";
import { s3ObjectStore } from "../bucket/s3-object-store.js";
import type { CellRuntime } from "../core/runtime.js";
import { loadNodeProject } from "../project/node-project.js";
import { withUpgrade } from "../ws/upgrade.js";
import { bridgeUpgrade, celldPeers, startCelldPeerServer } from "./celld-peer.js";

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
  /** A directory for the cells' local SQLite files (default: memory; the bucket is the copy). */
  data?: string;
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
  const bucket = celldBucket(o.store ?? s3(), { node, leaseTtlMs: o.leaseTtlMs });
  const project = await loadNodeProject(o.dir, {
    openSql: nodeSqliteOpener(o.data),
    files: new MemFilesApi(),
    storage: bucket,
    peers: celldPeers({ store, node }),
  });
  const { runtime } = project;
  const [peerHost, peerPort] = hostPort(o.internalListen ?? "127.0.0.1:0", "--internal-listen");
  const peer = await startCelldPeerServer({
    runtime,
    store,
    node,
    host: peerHost,
    port: peerPort,
    probe: (c) => bucket.probe(c),
  });
  const addr = o.advertise ?? peer.addr;
  await bucket.advertise(addr);

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
  const server: Server = createServer(async (req, res) => {
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
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
        await new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        });
        for (const c of wss.clients) c.terminate();
        await peer.close();
        // releases every owned cell (own.json → released) and deletes the node record
        await runtime.close();
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
  if (out.endpoint === undefined) delete out.endpoint;
  return out;
}
