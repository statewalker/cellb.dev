// Experiment page: single-use Web Workers, each with its own Wasmer client and one ready sandbox.

import type { Container } from "../../src/container.ts";
import { createContainer } from "../../src/container.ts";
import { HostMounts, serveHostFiles } from "../../src/files/bridge.ts";
import { connectEngine } from "../../src/rpc.ts";

const mounts = new HostMounts();
type Slot = { worker: Worker; container: Container; warmMs: number };
const warm: Slot[] = [];

async function warmWorker(): Promise<Slot> {
  const t = performance.now();
  const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
  const e = new MessageChannel();
  const f = new MessageChannel();
  serveHostFiles(f.port1, mounts);
  worker.postMessage({ engine: e.port2, files: f.port2 }, [e.port2, f.port2]);
  const container = createContainer(connectEngine(e.port1), { packages: ["python/python"] });
  await container.start();
  await container.exec(["python", "-c", "pass"]);
  return { worker, container, warmMs: Math.round(performance.now() - t) };
}

Object.assign(window, {
  async __wpWarm(n: number) {
    const slots = await Promise.all(Array.from({ length: n }, warmWorker));
    warm.push(...slots);
    return slots.map((s) => s.warmMs);
  },
  /** Takes a warm worker, runs a command, terminates the worker. */
  async __wpRunOnce(i: number) {
    const s = warm.shift();
    if (!s) throw new Error("no warm worker");
    const t = performance.now();
    const r = await s.container.exec(["python", "-c", `print(sum(range(10**6)), ${i})`]);
    const runMs = Math.round(performance.now() - t);
    const tt = performance.now();
    s.worker.terminate();
    return { runMs, terminateMs: Math.round(performance.now() - tt), exitCode: r.exitCode };
  },
  async __wpRefill() {
    const s = await warmWorker();
    warm.push(s);
    return s.warmMs;
  },
  __wpTerminateAll() {
    for (const s of warm.splice(0)) s.worker.terminate();
  },
});
