// A ContainerEngine on Lifo (https://lifo.sh): a Linux-like OS in TypeScript (kernel, shell, VFS,
// Node-compatible JS). Run it inside a worker of its own (serveContainerWorker): Lifo's in-realm
// Sandbox is not a security boundary, and terminating the worker is what frees it. Keep that
// worker dedicated: Lifo takes everything its realm writes to `console` while a command runs as
// the command's output.

import {
  isWebSocketUpgrade,
  requestedProtocols,
  upgradeWebSocket,
} from "@statewalker/webrun-http-browser";
import type { ContainerEngine, ContainerHandle, ExecResult } from "./engine.ts";
import { type SyncFilesCall, syncHostFiles } from "./files/sync-client.ts";
import { CHUNK_BYTES } from "./files/volume.ts";
import type { PortLike } from "./rpc.ts";

// The parts of @lifo-sh/core this engine uses (it stays an optional peer dependency).
interface LifoStat {
  type: "file" | "directory" | "symlink";
  size: number;
  ctime: number;
  mtime: number;
  mode: number;
}
interface LifoMountProvider {
  readFile(p: string): Uint8Array;
  readFileString(p: string): string;
  writeFile(p: string, content: string | Uint8Array): void;
  exists(p: string): boolean;
  stat(p: string): LifoStat;
  readdir(p: string): { name: string; type: LifoStat["type"] }[];
  unlink(p: string): void;
  mkdir(p: string, options?: { recursive?: boolean }): void;
  rmdir(p: string): void;
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
}
interface LifoSandbox {
  commands: {
    run(cmd: string, o?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  };
  fs: { mkdir(p: string, o?: { recursive?: boolean }): Promise<void> };
  kernel: { vfs: { mount(path: string, provider: LifoMountProvider): void } };
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<Response>;
  waitForPort(port: number, o?: { timeout?: number }): Promise<void>;
  connect(
    port: number,
    url?: string,
    o?: { protocol?: string; timeout?: number },
  ): Promise<LifoVmSocket>;
  destroy(): void;
}
interface LifoVmSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  onmessage: ((e: { data: string | Uint8Array }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: Error) => void) | null;
}

/**
 * A WebSocket into the box: Lifo's in-box connection to the server on `port` (its http.Server's
 * `upgrade` event), bridged to the server end of a MessagePort socket, whose other port goes back
 * in the 101 (webrun-http-browser). Lifo offers one subprotocol: the first one asked for.
 */
async function upgradeIntoBox(box: LifoSandbox, port: number, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const [protocol] = requestedProtocols(request);
  let vm: LifoVmSocket;
  try {
    vm = await box.connect(port, url.pathname + url.search, {
      ...(protocol && { protocol }),
      timeout: 10_000,
    });
  } catch (e) {
    return new Response(`no WebSocket server on port ${port}: ${(e as Error).message}`, {
      status: 502,
    });
  }
  const { socket, response } = upgradeWebSocket(request, { protocol: protocol ?? "" });
  socket.binaryType = "arraybuffer";
  let open = true;
  vm.onmessage = (e) => {
    if (open) socket.send(e.data);
  };
  vm.onclose = (e) => {
    if (!open) return;
    open = false;
    const code =
      e.code >= 3000 || (e.code >= 1000 && ![1004, 1005, 1006].includes(e.code)) ? e.code : 1000;
    socket.close(code, e.reason);
  };
  vm.onerror = () => {};
  socket.addEventListener("message", (e) => {
    const data = (e as MessageEvent).data;
    vm.send(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  });
  socket.addEventListener("close", () => {
    if (!open) return;
    open = false;
    vm.close();
  });
  socket.accept();
  return response;
}

/** The @lifo-sh/core module (or the part of it this engine uses): `import * as lifo from "@lifo-sh/core"`. */
export interface LifoModule {
  Sandbox: {
    create(o?: {
      env?: Record<string, string>;
      cwd?: string;
      files?: Record<string, string | Uint8Array>;
    }): Promise<unknown>;
  };
  VFSError?: new (code: string, message: string) => Error;
}

const quote = (argv: string[]) => argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");

/** A Lifo mount backed by a host FilesApi, through the synchronous host-filesystem client. */
export function lifoMount(
  call: SyncFilesCall,
  VFSError?: LifoModule["VFSError"],
): LifoMountProvider {
  const rel = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");
  const run = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "EIO";
      throw VFSError ? new VFSError(code, (e as Error).message) : e;
    }
  };
  const ms = (ns?: string) => (ns ? Number(BigInt(ns) / 1_000_000n) : Date.now());
  const toStat = (m: {
    kind: string;
    size: number;
    modified?: string;
    created?: string;
  }): LifoStat => ({
    type: m.kind === "directory" ? "directory" : "file",
    size: m.size,
    mtime: ms(m.modified),
    ctime: ms(m.created ?? m.modified),
    mode: m.kind === "directory" ? 0o40755 : 0o100644,
  });
  const readAll = (p: string) => {
    const fd = call("open", [rel(p), true, false, false, false, false, false]);
    try {
      const chunks: Uint8Array[] = [];
      for (let offset = 0; ; ) {
        const chunk = call("read", [fd, offset, CHUNK_BYTES]) as Uint8Array;
        if (!chunk.length) break;
        chunks.push(chunk);
        offset += chunk.length;
        if (chunk.length < CHUNK_BYTES) break;
      }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    } finally {
      call("close", [fd]);
    }
  };
  const writeAll = (p: string, content: string | Uint8Array) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const fd = call("open", [rel(p), false, true, true, false, true, false]);
    try {
      for (let at = 0; at < bytes.length; at += CHUNK_BYTES)
        call("write", [fd, at, bytes.subarray(at, at + CHUNK_BYTES)]);
    } finally {
      call("close", [fd]);
    }
  };
  return {
    readFile: (p) => run(() => readAll(p)),
    readFileString: (p) => run(() => new TextDecoder().decode(readAll(p))),
    writeFile: (p, c) => run(() => writeAll(p, c)),
    exists(p) {
      try {
        call("stat", [rel(p)]);
        return true;
      } catch {
        return false;
      }
    },
    stat: (p) => run(() => toStat(call("stat", [rel(p)]) as never)),
    readdir: (p) =>
      run(() =>
        (call("readDir", [rel(p)]) as { name: string; kind: string }[]).map((e) => ({
          name: e.name,
          type: e.kind === "directory" ? "directory" : "file",
        })),
      ),
    unlink: (p) => run(() => void call("remove", [rel(p)])),
    rmdir: (p) => run(() => void call("remove", [rel(p)])),
    mkdir: (p, o) =>
      run(() => {
        if (!o?.recursive) return void call("mkdir", [rel(p)]);
        const parts = rel(p).split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) {
          try {
            call("mkdir", [parts.slice(0, i).join("/")]);
          } catch (e) {
            if ((e as { code?: string }).code !== "EEXIST") throw e;
          }
        }
      }),
    rename: (a, b) => run(() => void call("rename", [rel(a), rel(b)])),
    copyFile: (a, b) => run(() => writeAll(b, readAll(a))),
  };
}

// Lifo fetches esbuild-wasm from unpkg (browsers) through the same fetch as its guests: its own
// runtime files stay reachable without egress.
const LIFO_RUNTIME_URLS =
  /^https:\/\/unpkg\.com\/esbuild-wasm@[\d.]+\/(esbuild\.wasm|esm\/browser\.min\.js|lib\/browser\.min\.js)$/;

export interface LifoEngineOptions {
  /** The port the pool serves mounted FilesApis on. */
  files?: PortLike;
  /**
   * "none" (default): containers have no network. "host": a container started with
   * `enableInternet: true` gets the realm's network (fetch), unfenced; for trusted build steps.
   */
  egress?: "none" | "host";
  /**
   * A WHATWG WebSocket class for the sockets the box opens (a guest's `WebSocket`, node:http
   * upgrades): installed as this realm's `WebSocket`, so those sockets go where the class sends
   * them (e.g. createWebSocketClass from @statewalker/webrun-http-browser, to the host's
   * handlers), whatever `egress` is. Without it, the realm's WebSocket follows `egress`.
   */
  webSocket?: WebSocketClass;
}

type WebSocketClass = new (url: string | URL, protocols?: string | string[]) => object;

/**
 * `webSocket` as the realm's WebSocket. In Node, Lifo's node:http upgrade client calls it as the
 * `ws` package's class, `new WebSocket(url, { protocols, headers })`: take the protocols.
 */
function asRealmWebSocket(Base: WebSocketClass): WebSocketClass {
  return new Proxy(Base, {
    construct(target, [url, p]) {
      const protocols =
        p && typeof p === "object" && !Array.isArray(p)
          ? ((p as { protocols?: string[] }).protocols ?? [])
          : p;
      return Reflect.construct(target, protocols === undefined ? [url] : [url, protocols]);
    },
  });
}

/**
 * Lifo reaches the network through its realm's fetch (npm, curl, a guest's fetch, node:http
 * clients), read at each call: guard it, and the realm's other ways out. The realm is the
 * engine's own (a dedicated worker), so its network is the engine's: with several containers in
 * one engine, the network is open while any running container was started with it.
 */
function guardRealmNetwork(allowed: () => boolean, webSocket?: WebSocketClass): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    fetch: g.fetch,
    WebSocket: g.WebSocket,
    XMLHttpRequest: g.XMLHttpRequest,
    EventSource: g.EventSource,
  };
  const refuse = (what: string) =>
    new TypeError(`network access refused: this container has no egress (${what})`);
  const realFetch = saved.fetch as typeof fetch | undefined;
  g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (realFetch && (allowed() || LIFO_RUNTIME_URLS.test(url))) return realFetch(input, init);
    return Promise.reject(refuse(url));
  };
  if (webSocket) g.WebSocket = asRealmWebSocket(webSocket);
  for (const name of ["WebSocket", "XMLHttpRequest", "EventSource"] as const) {
    if (name === "WebSocket" && webSocket) continue;
    const Real = saved[name] as (new (...a: unknown[]) => object) | undefined;
    if (!Real) continue;
    g[name] = new Proxy(Real, {
      construct(target, args) {
        if (!allowed()) throw refuse(name);
        return Reflect.construct(target, args);
      },
    });
  }
  return () => Object.assign(g, saved);
}

/** A ContainerEngine on Lifo. Run it in a worker of its own: it guards that realm's network. */
export function lifoContainerEngine(
  lifo: LifoModule,
  opts: LifoEngineOptions = {},
): ContainerEngine {
  const handles = new Set<ContainerHandle>();
  const online = new Set<object>(); // containers started with enableInternet
  const unguard = guardRealmNetwork(() => online.size > 0, opts.webSocket);
  return {
    get running() {
      return handles.size;
    },
    async close() {
      await Promise.all([...handles].map((h) => h.destroy()));
      unguard();
    },
    async start(spec) {
      if (spec.enableInternet && opts.egress !== "host")
        throw new Error(
          'enableInternet: true is refused: this engine has no egress (lifoContainerEngine(lifo, { egress: "host" }))',
        );
      const files = Object.fromEntries(
        Object.entries(spec.files ?? {}).map(([k, v]) => [
          `/workspace/${k.replace(/^\/+/, "")}`,
          v,
        ]),
      );
      const box = (await lifo.Sandbox.create({
        env: spec.env,
        cwd: "/workspace",
        files,
      })) as LifoSandbox;
      await box.fs.mkdir("/workspace", { recursive: true });
      for (const m of spec.mounts ?? []) {
        if (!opts.files) throw new Error("mounts need the pool's files port");
        box.kernel.vfs.mount(m.path, lifoMount(syncHostFiles(opts.files, m.id), lifo.VFSError));
      }
      const id = {};
      if (spec.enableInternet) online.add(id);
      if (spec.entrypoint?.length)
        await box.commands.run(`${quote(spec.entrypoint)} &`, {
          cwd: spec.workdir ?? "/workspace",
        });
      let running = true;
      let exit!: (r: { exitCode: number; reason: string }) => void;
      const exited = new Promise<{ exitCode: number; reason: string }>((r) => {
        exit = r;
      });
      const stop = async () => {
        if (!running) return;
        running = false;
        handles.delete(handle);
        online.delete(id);
        box.destroy();
        exit({ exitCode: 137, reason: "terminated" });
      };
      const handle: ContainerHandle = {
        get running() {
          return running;
        },
        monitor: () => exited,
        waitForPort: (port, timeoutMs = 30_000) => box.waitForPort(port, { timeout: timeoutMs }),
        async fetch(port, request) {
          if (isWebSocketUpgrade(request)) return upgradeIntoBox(box, port, request);
          const url = new URL(request.url);
          const body =
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : new Uint8Array(await request.arrayBuffer());
          return box.fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body,
          });
        },
        connect() {
          throw new Error("raw sockets are not supported by the Lifo engine");
        },
        exec: (argv, o = {}) =>
          box.commands.run(quote(argv), { cwd: o.cwd ?? spec.workdir ?? "/workspace", env: o.env }),
        signal: stop,
        destroy: stop,
      };
      handles.add(handle);
      return handle;
    },
  };
}
