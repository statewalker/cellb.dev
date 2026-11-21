// Runaway code: a guest in a pure compute loop ignores kill(), and keeps a Wasmer worker busy
// after its sandbox is destroyed. A recyclable engine runs the Wasmer client in a worker of its
// own and replaces it, terminating the old worker and the runaway thread with it.
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostMounts, serveHostFiles } from "../src/files/bridge.ts";
import { createContainerPool } from "../src/pool.ts";
import { type RecyclableEngine, recyclableEngine } from "../src/recycle.ts";
import { connectEngine } from "../src/rpc.ts";

const mounts = new HostMounts(); // the FilesApis live on this thread
let engine: RecyclableEngine;
let workers = 0;
beforeAll(() => {
  engine = recyclableEngine(() => {
    const worker = new Worker(new URL("./fixtures/pool-worker.ts", import.meta.url));
    workers++;
    const e = new MessageChannel();
    const f = new MessageChannel();
    serveHostFiles(f.port1, mounts);
    worker.postMessage({ engine: e.port2, files: f.port2 }, [e.port2 as never, f.port2 as never]);
    return { engine: connectEngine(e.port1), terminate: () => worker.terminate().then(() => {}) };
  });
});
afterAll(async () => {
  await engine?.terminate();
});

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const busyFor = async (ms: number) => {
  const c0 = cpuMs();
  await new Promise((r) => setTimeout(r, ms));
  return cpuMs() - c0;
};

describe("recyclableEngine with a pool", () => {
  it("serves runs from a worker, with FilesApis on this thread", async () => {
    const pool = createContainerPool(engine, mounts, {
      image: { packages: ["python/python"] },
      size: 1,
    });
    const files = new MemFilesApi();
    await writeText(files, "/in.txt", "from the main thread");
    const r = await pool.run({
      argv: [
        "python",
        "-c",
        "open('/data/out.txt','w').write(open('/data/in.txt').read().upper())",
      ],
      files,
    });
    expect(r.exitCode).toBe(0);
    expect(await readText(files, "/out.txt")).toBe("FROM THE MAIN THREAD");
    await pool.close();
  });

  it("a compute loop that outlives its timeout is stopped for real: the worker is replaced", async () => {
    const pool = createContainerPool(engine, mounts, {
      image: { packages: ["python/python"] },
      size: 1,
    });
    await pool.warm();
    const generation = engine.generation;
    const r = await pool.run({ argv: ["python", "-c", "while True:\n    pass"], timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(engine.generation).toBe(generation + 1);
    await pool.warm(); // the new worker has started its sandbox
    await new Promise((res) => setTimeout(res, 1000)); // and the old worker is terminated
    // Nothing spins any more: well under one core over 2 s (a runaway thread would use ~2,000 ms).
    expect(await busyFor(2000)).toBeLessThan(600);
    const files = new MemFilesApi();
    const next = await pool.run({
      argv: ["python", "-c", "import os; print(os.listdir('/data'))"],
      files,
    });
    expect(next.stdout.trim()).toBe("[]");
    await pool.close();
    expect(workers).toBeGreaterThanOrEqual(2);
  });
});
