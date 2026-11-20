// The spread probe (e2e-browser/probes/spread.probe.spec.ts): one project's Durable Objects
// spread over "nodes". A node is a group of shard workers (startProjectShards) run by this page
// or by a cross-origin iframe (frame.html). Tasks go to a node by a hash of the object's name,
// and inside a node to the worker that owns the object (shardOf).
import type { BrowserBucket } from "../../../src/project/browser-host.ts";
import { startProjectShards } from "../../../src/project/browser-shards.ts";
import { linkOverPort, serveHandlerOverPort } from "../../../src/transport/port.ts";

export interface SpreadProject {
  config: any;
  code: string;
}

export interface SpreadNode {
  label: string;
  workers: number;
  send(req: Request): Promise<Response>;
  estimate(): Promise<{ usage?: number; quota?: number }>;
  close(): Promise<void>;
}

/** A node of this page: `shards` workers that run the project together. */
export async function startLocal(opts: {
  label: string;
  shards: number;
  project: SpreadProject;
  bucket?: BrowserBucket;
  /** The shard worker's script (default: ./shard-worker.ts). */
  workerUrl?: string;
}): Promise<SpreadNode> {
  const app = await startProjectShards({
    shards: opts.shards,
    spawn: (i) =>
      new Worker(opts.workerUrl ?? new URL("./shard-worker.ts", import.meta.url), {
        type: "module",
        name: `${opts.label}-w${i}`,
      }),
    config: opts.project.config,
    code: { bundle: opts.project.code },
    name: `${opts.label}-${Date.now().toString(36)}`,
    bucket: opts.bucket,
  });
  return {
    label: opts.label,
    workers: opts.shards,
    send: (req) => app.fetch(req),
    estimate: () => navigator.storage.estimate(),
    close: () => app.close(),
  };
}

/**
 * A node in an iframe of another origin (`origin`/spread/frame.html). The page hands the frame
 * two ports: one carries the project's HTTP (served with serveHandlerOverPort there), the other
 * this probe's control calls.
 */
export async function startFrame(opts: {
  origin: string;
  label: string;
  shards: number;
  project: SpreadProject;
  timeoutMs?: number;
}): Promise<
  SpreadNode & { frame: HTMLIFrameElement; call(op: string, arg?: unknown): Promise<any> }
> {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = `${opts.origin}/spread/frame.html`;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`frame ${opts.origin} did not load`)),
      opts.timeoutMs ?? 30_000,
    );
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.type !== "spread:ready") return;
      removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve();
    };
    addEventListener("message", onMessage);
  });
  document.body.append(frame);
  await ready;
  const ctl = new MessageChannel();
  const data = new MessageChannel();
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  ctl.port1.onmessage = (e) => {
    // id -1: the frame could not read a message (a messageerror): every call waiting fails.
    const ids = e.data.id === -1 ? [...pending.keys()] : [e.data.id];
    for (const id of ids) {
      pending.get(id)?.(e.data);
      pending.delete(id);
    }
  };
  const call = (op: string, arg?: unknown, transfer: Transferable[] = []) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))));
      ctl.port1.postMessage({ id, op, arg }, transfer);
    });
  frame.contentWindow!.postMessage({ type: "spread:start" }, opts.origin, [ctl.port2, data.port2]);
  await call("start", { label: opts.label, shards: opts.shards, project: opts.project });
  const link = await linkOverPort(data.port1);
  return {
    label: opts.label,
    workers: opts.shards,
    frame,
    call,
    send: link.send,
    estimate: () => call("estimate"),
    async close() {
      await call("close").catch(() => {});
      link.close();
      frame.remove();
    },
  };
}

/** The frame side: started by startFrame's ports. (A probe: it accepts any parent.) */
export function serveFrame() {
  addEventListener("message", (e: MessageEvent) => {
    if (e.source !== parent || e.data?.type !== "spread:start") return;
    const [ctl, data] = e.ports;
    let node: SpreadNode | undefined;
    // A message this origin cannot deserialize (a directory handle of another origin, say)
    // arrives as a messageerror, without its id.
    ctl.onmessageerror = () =>
      ctl.postMessage({
        id: -1,
        ok: false,
        error: "messageerror: the frame could not read the message",
      });
    ctl.onmessage = async (m) => {
      const { id, op, arg } = m.data;
      try {
        let result: unknown;
        if (op === "start") {
          node = await startLocal(arg);
          await serveHandlerOverPort(data, (req: Request) => node!.send(req));
        } else if (op === "estimate") result = await navigator.storage.estimate();
        else if (op === "close") await node?.close();
        else if (op === "write-handle") {
          // A directory handle the parent posted: can this origin write through it?
          const dir = arg as FileSystemDirectoryHandle;
          const file = await dir.getFileHandle(`from-${location.host}.txt`, { create: true });
          const w = await file.createWritable();
          await w.write(`written by ${location.origin}`);
          await w.close();
          result = "written";
        } else throw new Error(`unknown op ${op}`);
        ctl.postMessage({ id, ok: true, result });
      } catch (err) {
        ctl.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
      }
    };
  });
  parent.postMessage({ type: "spread:ready" }, "*");
}

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * `rounds` tasks for each name, `concurrency` in flight. Returns the throughput and how many
 * tasks each worker ran.
 */
export async function runTasks(
  nodes: SpreadNode[],
  opts: { names: string[]; rounds: number; kb: number; work: number; concurrency?: number },
) {
  const queue: string[] = [];
  for (let r = 0; r < opts.rounds; r++) queue.push(...opts.names);
  const perWorker: Record<string, number> = {};
  const errors: string[] = [];
  let done = 0;
  const t0 = performance.now();
  const loop = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const node = nodes[hash(name) % nodes.length];
      try {
        const res = await node.send(
          new Request(`http://spread/task?name=${name}&kb=${opts.kb}&work=${opts.work}`),
        );
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        const r = await res.json();
        perWorker[r.worker] = (perWorker[r.worker] ?? 0) + 1;
        done++;
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err).slice(0, 300));
        if (errors.length >= 20) queue.length = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 64 }, loop));
  const ms = performance.now() - t0;
  return {
    tasks: done,
    ms: Math.round(ms),
    tasksPerSec: Math.round((done * 1000) / ms),
    mbPerSec: Math.round(((done * opts.kb) / 1024 / (ms / 1000)) * 10) / 10,
    workersUsed: Object.keys(perWorker).length,
    perWorker,
    errors: errors.slice(0, 5),
    errorCount: errors.length,
  };
}

/** Every object's rows: how many, how many bytes, and in how many workers they were written. */
export async function objectStats(nodes: SpreadNode[], names: string[]) {
  let rows = 0;
  let bytes = 0;
  let movedObjects = 0;
  for (const name of names) {
    const node = nodes[hash(name) % nodes.length];
    const s = await (await node.send(new Request(`http://spread/stats?name=${name}`))).json();
    rows += s.n;
    bytes += s.bytes;
    if (s.workers > 1) movedObjects++;
  }
  return { rows, bytes, movedObjects };
}
