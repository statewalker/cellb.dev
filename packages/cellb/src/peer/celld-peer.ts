import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ObjectStore } from "../bucket/object-store.js";
import type { CellRuntime } from "../core/runtime.js";
import { deserialize, serialize } from "../v8/serialize.js";

/**
 * celld's peer protocol (peer_auth.rs, main/peer_tunnel.rs, protocol 5) for a webrun-cells node
 * hosted in Node, so celld nodes can route a cell's requests to it when it owns the cell.
 *
 * Authentication: every peer request carries an HMAC-SHA-256 over
 *   "cells-peer-request-v1\n5\n<method>\n<path?query>\n<sha256(body)>\n<source>\n<target>\n<ts>\n<nonce>"
 * keyed by the fleet secret in `fleet/peer-auth.json`, with headers x-cells-peer-{version,
 * source,target,timestamp,nonce,body-sha256,signature}; ±30 s clock window, nonce replay cache,
 * and the target must be this node.
 *
 * Tunnel: `GET /peer/tunnel` with `Upgrade: celld-tunnel` (kind `do` or `rpc`) is answered with
 * 101; then the connection carries plain HTTP/1.1 requests, one call each, with control headers
 * x-cells-scope (the cell, "<Class>:<idhex>"), x-cells-do-name, x-cells-request-id:
 *   do  — the application request as is; the reply streams back.
 *   rpc — POST, method in x-cells-rpc-method, arguments V8-serialized (an array) or JSON; the
 *         reply is the V8-serialized result, or a tagged error (0, then [error, props]).
 * A cell this node does not own answers 409 with `x-cells-route-error: stale-owner`, so celld
 * re-resolves the owner.
 */
const PROTOCOL = "5";
const DOMAIN = "cells-peer-request-v1";
const CLOCK_WINDOW_MS = 30_000;
const H = {
  version: "x-cells-peer-version",
  source: "x-cells-peer-source",
  target: "x-cells-peer-target",
  timestamp: "x-cells-peer-timestamp",
  nonce: "x-cells-peer-nonce",
  bodySha: "x-cells-peer-body-sha256",
  signature: "x-cells-peer-signature",
} as const;
const CONTROL = [
  "x-cells-scope",
  "x-cells-do-name",
  "x-cells-request-id",
  "x-cells-capacity-handoff",
];

/** The fleet's peer secret (celld creates it in the bucket). */
export async function loadPeerKey(store: ObjectStore): Promise<Uint8Array> {
  const o = await store.get("fleet/peer-auth.json");
  if (!o) throw new Error("the fleet has no peer authentication secret; start a celld node first");
  const { version, key } = JSON.parse(new TextDecoder().decode(o.body)) as {
    version: number;
    key: string;
  };
  if (version !== 1 || !/^[0-9a-f]{64}$/.test(key))
    throw new Error("unexpected fleet/peer-auth.json");
  return Uint8Array.from(Buffer.from(key, "hex"));
}

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const mac = (
  key: Uint8Array,
  c: {
    method: string;
    path: string;
    bodySha: string;
    source: string;
    target: string;
    ts: string;
    nonce: string;
  },
) =>
  createHmac("sha256", key)
    .update(
      `${DOMAIN}\n${PROTOCOL}\n${c.method}\n${c.path}\n${c.bodySha}\n${c.source}\n${c.target}\n${c.ts}\n${c.nonce}`,
    )
    .digest();

/** Headers that sign one peer request from `source` to `target`. */
export function signPeerRequest(
  key: Uint8Array,
  source: string,
  target: string,
  method: string,
  pathAndQuery: string,
  body: Uint8Array = new Uint8Array(),
) {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodySha = sha256hex(body);
  const signature = mac(key, {
    method,
    path: pathAndQuery,
    bodySha,
    source,
    target,
    ts,
    nonce,
  }).toString("hex");
  return {
    [H.version]: PROTOCOL,
    [H.source]: source,
    [H.target]: target,
    [H.timestamp]: ts,
    [H.nonce]: nonce,
    [H.bodySha]: bodySha,
    [H.signature]: signature,
  };
}

/** celld's verification; returns a status and message on failure. */
export function verifyPeerRequest(
  key: Uint8Array,
  self: string,
  method: string,
  pathAndQuery: string,
  headers: Record<string, string | string[] | undefined>,
  body: Uint8Array,
  seen: Map<string, number>,
): { status: number; message: string; stale?: boolean } | undefined {
  const h = (n: string) => (typeof headers[n] === "string" ? (headers[n] as string) : undefined);
  const version = h(H.version);
  if (version === undefined) return { status: 401, message: "peer authentication failed" };
  if (version !== PROTOCOL)
    return { status: 426, message: "peer protocol version is incompatible" };
  const [source, target, ts, nonce, bodySha, signature] = [
    H.source,
    H.target,
    H.timestamp,
    H.nonce,
    H.bodySha,
    H.signature,
  ].map(h);
  if (!source || !target || !ts || !nonce || !bodySha || !signature)
    return { status: 401, message: "peer authentication failed" };
  const now = Date.now();
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > CLOCK_WINDOW_MS)
    return { status: 401, message: "peer authentication failed" };
  if (
    sha256hex(body) !== bodySha ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return { status: 401, message: "peer authentication failed" };
  const expected = mac(key, { method, path: pathAndQuery, bodySha, source, target, ts, nonce });
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return { status: 401, message: "peer authentication failed" };
  if (target !== self)
    return { status: 409, message: "peer request targets a different node session", stale: true };
  for (const [n, t] of seen) if (now - t > 2 * CLOCK_WINDOW_MS) seen.delete(n);
  if (seen.has(nonce)) return { status: 409, message: "peer request replay rejected" };
  seen.set(nonce, now);
  return undefined;
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
};

/** The cell a scope names, as a stub of this runtime (undefined: not a class we host). */
function stubFor(runtime: CellRuntime, scope: string, name: string | undefined): any {
  const m = /^([^:]+):([0-9a-f]{64})$/.exec(scope);
  if (!m) return undefined;
  const binding = Object.entries(runtime.durableObjectBindings).find(
    ([, cls]) => cls === m[1],
  )?.[0];
  if (!binding) return undefined;
  const ns = runtime.env[binding] as any;
  return name !== undefined ? ns.getByName(name) : ns.get(ns.idFromString(m[2]));
}

const notOwner = (e: unknown) =>
  /owned by another|OwnedElsewhere|lease/i.test(String((e as Error)?.message ?? e)) ||
  (e as Error)?.name === "CellOwnedElsewhereError";

function reply(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array | string,
) {
  res.writeHead(status, { [H.version]: PROTOCOL, ...headers });
  res.end(body);
}
const stale = (res: ServerResponse) =>
  reply(
    res,
    409,
    { "x-cells-route-error": "stale-owner", "content-type": "text/plain" },
    "stale route",
  );

export interface CelldPeerServer {
  /** host:port celld dials (put it in the node record: celldBucket({ addr })). */
  addr: string;
  close(): Promise<void>;
}

/**
 * Serves celld's peer tunnel for `runtime` on `host:port` (0: any free port). `node` is this
 * node's name in the fleet (the same as celldBucket's `node`).
 */
export async function startCelldPeerServer(opts: {
  runtime: CellRuntime;
  store: ObjectStore;
  node: string;
  host?: string;
  port?: number;
}): Promise<CelldPeerServer> {
  const key = await loadPeerKey(opts.store);
  const seen = new Map<string, number>();
  const host = opts.host ?? "127.0.0.1";

  const serveDo = async (req: IncomingMessage, res: ServerResponse) => {
    const scope = String(req.headers["x-cells-scope"] ?? "");
    const name = req.headers["x-cells-do-name"] as string | undefined;
    const stub = stubFor(opts.runtime, scope, name);
    if (!stub) return reply(res, 400, {}, "malformed cell scope");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string" && !CONTROL.includes(k)) headers.set(k, v);
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const url = /^https?:\/\//.test(req.url ?? "")
      ? (req.url as string)
      : `http://${req.headers.host ?? "cell"}${req.url ?? "/"}`;
    try {
      const r: Response = await stub.fetch(new Request(url, { method, headers, body }));
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (k !== "content-length" && k !== "transfer-encoding" && k !== "connection") out[k] = v;
      });
      reply(res, r.status, out, new Uint8Array(await r.arrayBuffer()));
    } catch (e) {
      if (notOwner(e)) return stale(res);
      reply(res, 500, { "content-type": "text/plain" }, String((e as Error)?.message ?? e));
    }
  };

  const serveRpc = async (req: IncomingMessage, res: ServerResponse) => {
    const scope = String(req.headers["x-cells-scope"] ?? "");
    const stub = stubFor(opts.runtime, scope, req.headers["x-cells-do-name"] as string | undefined);
    const method = req.headers["x-cells-rpc-method"] as string | undefined;
    if (!stub) return reply(res, 400, {}, "malformed cell scope");
    if (!method) return reply(res, 400, {}, "RPC method header is missing");
    const raw = await readBody(req);
    const structured = req.headers["content-type"] === "application/octet-stream";
    let args: unknown[];
    if (structured) {
      if (raw[0] !== 0xff) return reply(res, 501, {}, "RPC stubs cannot cross to webrun-cells");
      args = deserialize(raw) as unknown[];
    } else args = JSON.parse(new TextDecoder().decode(raw)) as unknown[];
    try {
      const result = await stub[method](...(Array.isArray(args) ? args : [args]));
      if (structured)
        reply(res, 200, { "content-type": "application/octet-stream" }, serialize(result));
      else reply(res, 200, { "content-type": "application/json" }, JSON.stringify(result ?? null));
    } catch (e) {
      if (notOwner(e)) return stale(res);
      if (!structured)
        return reply(
          res,
          500,
          { "content-type": "text/plain" },
          `RPC failed: ${String((e as Error)?.message ?? e)}`,
        );
      // celld's callee exception: tag 0, then [error, own properties incl. name]
      const err = e instanceof Error ? e : new Error(String(e));
      const props = e instanceof Error ? { ...e, name: e.name } : { name: "Error" };
      const sc = serialize([err, props]);
      const tagged = new Uint8Array(sc.length + 1);
      tagged.set(sc, 1);
      reply(res, 200, { "content-type": "application/octet-stream" }, tagged);
    }
  };

  // One inner HTTP/1.1 server per tunnel kind: an upgraded socket becomes its connection.
  // celld's inner RPC requests carry no Host header: Node would answer 400 by default.
  const inner = {
    do: createServer({ requireHostHeader: false }, (q, s) => void serveDo(q, s)),
    rpc: createServer({ requireHostHeader: false }, (q, s) => void serveRpc(q, s)),
  };
  for (const s of Object.values(inner)) s.keepAliveTimeout = 0;

  const server: Server = createServer((req, res) => reply(res, 404, {}, "not found"));
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = req.url ?? "/";
    const refuse = (status: number, message: string, extra: Record<string, string> = {}) => {
      const lines = [
        `HTTP/1.1 ${status} ${message}`,
        `${H.version}: ${PROTOCOL}`,
        "connection: close",
        "content-length: 0",
      ];
      for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
      socket.end(`${lines.join("\r\n")}\r\n\r\n`);
    };
    if (path !== "/peer/tunnel" || req.headers.upgrade !== "celld-tunnel")
      return refuse(404, "Not Found");
    const denied = verifyPeerRequest(
      key,
      opts.node,
      req.method ?? "GET",
      path,
      req.headers,
      new Uint8Array(),
      seen,
    );
    if (denied)
      return refuse(
        denied.status,
        denied.message,
        denied.stale ? { "x-cells-route-error": "stale-owner" } : {},
      );
    if (req.headers["x-cells-tunnel-version"] !== "5") return refuse(426, "Upgrade Required");
    const kind = req.headers["x-cells-tunnel-kind"];
    if (kind !== "do" && kind !== "rpc") return refuse(400, "Bad Request");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "upgrade: celld-tunnel",
        "connection: upgrade",
        "x-cells-tunnel-version: 5",
        `${H.version}: ${PROTOCOL}`,
      ].join("\r\n") + "\r\n\r\n",
    );
    if (head?.length) socket.unshift(head);
    inner[kind].emit("connection", socket);
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, host, () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    addr: `${host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        for (const s of Object.values(inner)) s.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/**
 * The calling half (celld's node A): open a signed tunnel to the owner node and send one call
 * through it — `fetch` on a `do` tunnel, JS RPC on an `rpc` tunnel (V8-serialized arguments;
 * the reply decoded as celld encodes it, a callee exception rethrown with its properties).
 */
async function tunnelCall(
  key: Uint8Array,
  source: string,
  owner: { node: string; addr: string },
  kind: "do" | "rpc",
  inner: { method: string; path: string; headers: Record<string, string>; body?: Uint8Array },
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const { request } = await import("node:http");
  const [host, port] = [
    owner.addr.slice(0, owner.addr.lastIndexOf(":")),
    Number(owner.addr.slice(owner.addr.lastIndexOf(":") + 1)),
  ];
  const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const req = request({
      host,
      port,
      path: "/peer/tunnel",
      method: "GET",
      headers: {
        upgrade: "celld-tunnel",
        connection: "upgrade",
        "x-cells-tunnel-version": "5",
        "x-cells-tunnel-kind": kind,
        ...signPeerRequest(key, source, owner.node, "GET", "/peer/tunnel"),
      },
    });
    req.on("upgrade", (_res, sock) => resolve(sock as import("node:net").Socket));
    req.on("response", (res) =>
      reject(
        Object.assign(new Error(`peer tunnel refused: ${res.statusCode}`), {
          stale: res.headers["x-cells-route-error"] === "stale-owner",
        }),
      ),
    );
    req.on("error", reject);
    req.end();
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        // no agent: the request runs on the upgraded socket itself
        {
          createConnection: () => socket,
          method: inner.method,
          path: inner.path,
          headers: inner.headers,
        },
        async (res) => {
          const chunks: Buffer[] = [];
          for await (const c of res) chunks.push(c as Buffer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === "string") headers[k] = v;
          resolve({
            status: res.statusCode ?? 500,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          });
        },
      );
      req.on("error", reject);
      req.end(inner.body);
    });
  } finally {
    socket.destroy();
  }
}

/**
 * Routing to cells celld nodes own, for CellRuntimeOptions.peers: `ownerOf` reads the cell's
 * own.json, `endpoint` reaches the owner's address from its node record through the tunnel.
 */
export function celldPeers(opts: { store: ObjectStore; node: string }) {
  let key: Promise<Uint8Array> | undefined;
  const json = async <T>(k: string) => {
    const o = await opts.store.get(k);
    return o ? (JSON.parse(new TextDecoder().decode(o.body)) as T) : undefined;
  };
  const staleError = (cellKey: string) =>
    Object.assign(new Error(`${cellKey} is owned by another node`), {
      name: "CellOwnedElsewhereError",
    });
  return {
    async ownerOf(cellKey: string) {
      const own = await json<{ node: string }>(`cells/${cellKey.replace("/", ":")}/own.json`);
      return own?.node && own.node !== opts.node ? own.node : undefined;
    },
    link(): never {
      throw new Error("celld owners are reached through endpoint()");
    },
    async endpoint(owner: string, cellKey: string, name: string | undefined) {
      const lease = await json<{ addr: string; expires_ms: number }>(`nodes/${owner}.json`);
      if (!lease?.addr || lease.expires_ms <= Date.now()) return undefined;
      key ??= loadPeerKey(opts.store);
      const k = await key;
      const target = { node: owner, addr: lease.addr };
      const scope = cellKey.replace("/", ":");
      const control = (h: Record<string, string>) => ({
        ...h,
        "x-cells-scope": scope,
        ...(name !== undefined ? { "x-cells-do-name": name } : {}),
      });
      return {
        async fetch(req: Request) {
          const url = new URL(req.url);
          const headers: Record<string, string> = {};
          req.headers.forEach((v, h) => {
            if (!h.startsWith("x-cells-")) headers[h] = v;
          });
          headers.host ??= url.host;
          const body =
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : new Uint8Array(await req.arrayBuffer());
          const r = await tunnelCall(k, opts.node, target, "do", {
            method: req.method,
            path: url.pathname + url.search,
            headers: control(headers),
            body,
          });
          if (r.status === 409 && r.headers["x-cells-route-error"] === "stale-owner")
            throw staleError(cellKey);
          const out = new Headers();
          for (const [h, v] of Object.entries(r.headers))
            if (!h.startsWith("x-cells-")) out.set(h, v);
          return new Response(r.status === 204 || r.status === 304 ? null : (r.body as BodyInit), {
            status: r.status,
            headers: out,
          });
        },
        async call(method: string, args: unknown[]) {
          const body = serialize(args);
          const r = await tunnelCall(k, opts.node, target, "rpc", {
            method: "POST",
            path: "/",
            headers: control({
              "x-cells-rpc-method": method,
              "content-type": "application/octet-stream",
              "content-length": String(body.length),
            }),
            body,
          });
          if (r.status === 409 && r.headers["x-cells-route-error"] === "stale-owner")
            throw staleError(cellKey);
          if (r.status !== 200)
            throw new Error(
              `remote RPC failed with ${r.status}: ${new TextDecoder().decode(r.body)}`,
            );
          if (r.body[0] === 0xff) return deserialize(r.body);
          if (r.body[0] === 0) {
            const [error, props] = deserialize(r.body.subarray(1)) as [
              unknown,
              Record<string, unknown>,
            ];
            if (error instanceof Error) Object.assign(error, props, { remote: true });
            throw error;
          }
          throw new Error("RPC stubs cannot cross from celld to webrun-cells");
        },
      };
    },
  };
}
