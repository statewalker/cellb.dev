// A pool of isolated containers: each one in a worker of its own, prepared ahead of time, used for
// one request and then terminated with its worker; a fresh one takes its place.
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedPool, type IsolatedPool } from "../src/isolated-pool.ts";

let spawned = 0;
let terminated = 0;
const spawn = () => {
  spawned++;
  const w = new Worker(new URL("./fixtures/isolated-wasmer-worker.ts", import.meta.url));
  const terminate = w.terminate.bind(w);
  w.terminate = () => {
    terminated++;
    return terminate();
  };
  return w;
};
const py = (code: string) => ["python", "-c", code];
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

let pool: IsolatedPool;
beforeAll(async () => {
  pool = createIsolatedPool({
    spawn,
    image: { packages: ["python/python"] },
    size: 2,
    warmup: py("pass"),
  });
  await pool.ready();
});
afterAll(async () => {
  await pool?.close();
});

describe("createIsolatedPool (Wasmer, one worker per container)", () => {
  it("keeps `size` containers ready, each in its own worker", () => {
    expect(pool.idle).toBe(2);
    expect(spawned).toBe(2);
  });

  it("acquire() gives a running container with Cloudflare's API; destroy() terminates its worker", async () => {
    const before = terminated;
    const c = await pool.acquire();
    expect(c.running).toBe(true);
    expect(await c.exec(py("print(6*7)"))).toMatchObject({ exitCode: 0, stdout: "42\n" });
    await c.destroy();
    expect(c.running).toBe(false);
    expect(terminated).toBe(before + 1);
    await pool.ready();
    expect(pool.idle).toBe(2); // replaced
  });

  it("run() mounts the run's own FilesApi; nothing of one run reaches the next", async () => {
    const a = new MemFilesApi();
    const b = new MemFilesApi();
    await writeText(a, "/in.txt", "from a");
    const first = await pool.run({
      argv: py(
        "import os\nopen('/tmp/leak','w').write('a')\nopen('/workspace/leak','w').write('a')\nopen('/data/out.txt','w').write(open('/data/in.txt').read().upper())\nprint(os.environ['WHO'])",
      ),
      files: a,
      env: { WHO: "a" },
    });
    expect(first).toMatchObject({ exitCode: 0, stdout: "a\n", timedOut: false });
    expect(await readText(a, "/out.txt")).toBe("FROM A");
    const second = await pool.run({
      argv: py(
        "import os, json\nprint(json.dumps([os.listdir('/data'), os.path.exists('/tmp/leak'), os.path.exists('/workspace/leak'), os.environ.get('WHO')]))",
      ),
      files: b,
    });
    expect(JSON.parse(second.stdout)).toEqual([[], false, false, null]);
  });

  it("makes requests wait when no container is ready, and serves every one", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => pool.run({ argv: py(`print(${i})`) })),
    );
    expect(results.map((r) => r.stdout.trim())).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("a timed-out run is stopped by terminating its worker, even a compute loop", async () => {
    const r = await pool.run({ argv: py("while True:\n    pass"), timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    await pool.ready();
    await new Promise((res) => setTimeout(res, 500));
    const c0 = cpuMs();
    await new Promise((res) => setTimeout(res, 2000));
    expect(cpuMs() - c0).toBeLessThan(600); // a loop still spinning would use ~2,000 ms
  });

  it("acquire() rejects after its timeout when nothing becomes ready", async () => {
    const slow = createIsolatedPool({
      spawn: () => {
        throw new Error("cannot start a worker");
      },
      image: { packages: ["python/python"] },
      size: 1,
    });
    await expect(slow.acquire({ timeoutMs: 300 })).rejects.toThrow(/timed out|cannot start/);
    await slow.close();
  });
});
