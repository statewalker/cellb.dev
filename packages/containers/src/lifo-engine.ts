// A ContainerEngine on Lifo (https://lifo.sh): a Linux-like OS in TypeScript (kernel, shell, VFS,
// Node-compatible JS). Run it inside a worker of its own (serveContainerWorker): Lifo's in-realm
// Sandbox is not a security boundary, and terminating the worker is what frees it. Keep that
// worker dedicated: Lifo takes everything its realm writes to `console` while a command runs as
// the command's output.
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
  destroy(): void;
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

/** A ContainerEngine on Lifo; `files` is the port the pool serves mounted FilesApis on. */
export function lifoContainerEngine(
  lifo: LifoModule,
  opts: { files?: PortLike } = {},
): ContainerEngine {
  const handles = new Set<ContainerHandle>();
  return {
    get running() {
      return handles.size;
    },
    async close() {
      await Promise.all([...handles].map((h) => h.destroy()));
    },
    async start(spec) {
      if (spec.enableInternet)
        throw new Error(
          "enableInternet: true needs an egress policy, which this engine does not have yet",
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
      if (spec.entrypoint?.length)
        await box.commands.run(`${quote(spec.entrypoint)} &`, { cwd: "/workspace" });
      let running = true;
      let exit!: (r: { exitCode: number; reason: string }) => void;
      const exited = new Promise<{ exitCode: number; reason: string }>((r) => {
        exit = r;
      });
      const stop = async () => {
        if (!running) return;
        running = false;
        handles.delete(handle);
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
          box.commands.run(quote(argv), { cwd: o.cwd ?? "/workspace", env: o.env }),
        signal: stop,
        destroy: stop,
      };
      handles.add(handle);
      return handle;
    },
  };
}
