// A ContainerEngine in another thread: serveEngine() where it runs, connectEngine() where cells run.
//
// The Wasmer client's core (package download and compile, virtual FS, scheduler) runs on the
// thread that created it, and its sandbox and process objects cannot be posted to another thread.
// So the engine lives in a worker and the cells hold a proxy implementing the same interface:
// calls are messages, request and response bodies are transferred buffers, and sockets and process
// stdio are transferred WHATWG streams. Works with browser MessagePorts / Workers and with Node's
// worker_threads ports.

import {
  takeUpgrade,
  webSocketUpgradeResponse,
  withHeaders,
} from "@statewalker/webrun-http-browser";
import type { ContainerEngine, ContainerHandle, ContainerSpec, SpawnedProcess } from "./engine.ts";
import { onMessage } from "./files/bridge.ts";

export interface PortLike {
  postMessage(message: unknown, transfer?: any[]): void;
}

type Reply = { result?: unknown; transfer?: any[] };
interface SerializedRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
}

async function serializeRequest(req: Request): Promise<SerializedRequest> {
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : new Uint8Array(await req.arrayBuffer());
  return { url: req.url, method: req.method, headers: [...req.headers], body };
}

/** Serves `engine` to the connectEngine() at the other end of `port`. */
export function serveEngine(port: PortLike, engine: ContainerEngine): void {
  const handles = new Map<number, ContainerHandle>();
  const processes = new Map<number, SpawnedProcess>();
  let next = 1;
  const handle = (id: unknown) => {
    const h = handles.get(id as number);
    if (!h) throw new Error("the container is gone");
    return h;
  };
  const ops: Record<string, (a: any) => Promise<Reply>> = {
    async start({ spec }: { spec: ContainerSpec }) {
      const h = await engine.start(spec);
      const hid = next++;
      handles.set(hid, h);
      void h.monitor().then((result) => {
        handles.delete(hid);
        port.postMessage({ event: "exit", hid, result });
      });
      return { result: hid };
    },
    async waitForPort({ hid, port: p, timeoutMs }) {
      await handle(hid).waitForPort(p, timeoutMs);
      return {};
    },
    async fetch({ hid, port: p, req }: { hid: number; port: number; req: SerializedRequest }) {
      // the headers ride as the request's own property: browsers drop Upgrade and Sec-* from it
      const res = await handle(hid).fetch(
        p,
        withHeaders(
          new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body as BodyInit | undefined,
          }),
          new Headers(req.headers),
        ),
      );
      const upgrade = takeUpgrade(res);
      if (upgrade) {
        // a WebSocket: the socket's port goes to the caller
        return {
          result: { status: 101, upgrade: { port: upgrade.port, protocol: upgrade.protocol } },
          transfer: [upgrade.port],
        };
      }
      const body = new Uint8Array(await res.arrayBuffer());
      return {
        result: { status: res.status, statusText: res.statusText, headers: [...res.headers], body },
        transfer: [body.buffer],
      };
    },
    async connect({
      hid,
      port: p,
      up,
      down,
    }: {
      hid: number;
      port: number;
      up: ReadableStream<Uint8Array>;
      down: WritableStream<Uint8Array>;
    }) {
      const sock = handle(hid).connect(p);
      void up.pipeTo(sock.writable).catch(() => sock.close());
      void sock.readable.pipeTo(down).catch(() => sock.close());
      return {};
    },
    async exec({ hid, argv, options }) {
      return { result: await handle(hid).exec(argv, options) };
    },
    async spawn({ hid, argv }) {
      const h = handle(hid);
      if (!h.spawn) throw new Error("this engine cannot spawn interactive processes");
      const p = await h.spawn(argv);
      const pid = next++;
      processes.set(pid, p);
      return {
        result: { pid, stdin: p.stdin, stdout: p.stdout, stderr: p.stderr },
        transfer: [p.stdin, p.stdout, p.stderr],
      };
    },
    async wait({ pid }) {
      const r = await processes.get(pid)!.wait();
      processes.delete(pid);
      return { result: r };
    },
    async kill({ pid }) {
      await processes.get(pid)?.kill();
      return {};
    },
    async signal({ hid, signo }) {
      await handle(hid).signal(signo);
      return {};
    },
    async destroy({ hid }) {
      await handles.get(hid)?.destroy();
      return {};
    },
    async close() {
      await engine.close();
      return {};
    },
  };
  onMessage(port, async (msg: { id: number; op: string; args: unknown }) => {
    if (typeof msg?.id !== "number" || !(msg.op in ops)) return;
    try {
      const { result, transfer = [] } = await ops[msg.op](msg.args ?? {});
      port.postMessage({ id: msg.id, result }, transfer);
    } catch (e) {
      port.postMessage({ id: msg.id, error: String((e as Error)?.message ?? e) });
    }
  });
}

/** A ContainerEngine whose containers run in the engine served at the other end of `port`. */
export function connectEngine(port: PortLike): ContainerEngine {
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const exits = new Map<number, (r: { exitCode: number; reason: string }) => void>();
  let next = 1;
  let live = 0;
  onMessage(
    port,
    (msg: { id?: number; result?: unknown; error?: string; event?: string; hid?: number }) => {
      if (msg?.event === "exit") {
        exits.get(msg.hid!)?.(msg.result as never);
        exits.delete(msg.hid!);
        return;
      }
      const p = pending.get(msg?.id as number);
      if (!p) return;
      pending.delete(msg.id!);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    },
  );
  const call = <T = any>(op: string, args: object = {}, transfer: any[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      port.postMessage({ id, op, args }, transfer);
    });

  return {
    get running() {
      return live;
    },
    async close() {
      await call("close");
    },
    async start(spec) {
      const hid = await call<number>("start", { spec });
      live++;
      let running = true;
      const exited = new Promise<{ exitCode: number; reason: string }>((resolve) =>
        exits.set(hid, resolve),
      ).then((r) => {
        running = false;
        live--;
        return r;
      });
      return {
        get running() {
          return running;
        },
        monitor: () => exited,
        waitForPort: (p, timeoutMs) => call("waitForPort", { hid, port: p, timeoutMs }),
        async fetch(p, request) {
          const r = await call("fetch", { hid, port: p, req: await serializeRequest(request) });
          if (r.upgrade) return webSocketUpgradeResponse(r.upgrade.port, r.upgrade.protocol);
          const noBody = request.method === "HEAD" || [101, 204, 205, 304].includes(r.status);
          return new Response(noBody ? null : r.body, {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
          });
        },
        connect(p) {
          const up = new TransformStream<Uint8Array, Uint8Array>();
          const down = new TransformStream<Uint8Array, Uint8Array>();
          void call("connect", { hid, port: p, up: up.readable, down: down.writable }, [
            up.readable,
            down.writable,
          ]);
          return {
            readable: down.readable,
            writable: up.writable,
            close: () => void up.writable.abort().catch(() => {}),
          };
        },
        exec: (argv, options) => call("exec", { hid, argv, options }),
        async spawn(argv) {
          const { pid, stdin, stdout, stderr } = await call("spawn", { hid, argv });
          return {
            stdin,
            stdout,
            stderr,
            wait: () => call("wait", { pid }),
            kill: () => call("kill", { pid }),
          };
        },
        signal: (signo) => call("signal", { hid, signo }),
        async destroy() {
          if (!running) return;
          await call("destroy", { hid });
          await exited;
        },
      };
    },
  };
}
