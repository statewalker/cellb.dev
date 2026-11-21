// Containers with several script slots: a worker (one Wasmer client) runs up to `slots` scripts at
// once. With isolation "sandbox" each script gets a fresh sandbox (its own FilesApi, /tmp,
// /workspace, env); with "shared" the scripts of a container share one sandbox, so a container is
// bound to one capabilities key and only runs with that key go to it.
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { createIsolatedPool } from "../src/isolated-pool.ts";

const qjs = (code: string) => ["qjs", "--std", "-e", code];
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
function spawner() {
  const counts = { spawned: 0, terminated: 0 };
  const spawn = () => {
    counts.spawned++;
    const w = new Worker(new URL("./fixtures/isolated-wasmer-worker.ts", import.meta.url));
    const terminate = w.terminate.bind(w);
    w.terminate = () => {
      counts.terminated++;
      return terminate();
    };
    return w;
  };
  return { spawn, counts };
}
// writes its secret to its /data, /workspace and /tmp, waits, then reports what it sees
const probe = (secret: string) =>
  qjs(`
    const w = (p, s) => { const f = std.open(p, "w"); f.puts(s); f.close(); };
    const r = (p) => { const f = std.open(p, "r"); if (!f) return null; const s = f.readAsString(); f.close(); return s; };
    w("/data/mine.txt", "${secret}"); w("/workspace/mine.txt", "${secret}"); w("/tmp/mine.txt", "${secret}");
    os.sleep(300);
    const [names] = os.readdir("/data");
    print(JSON.stringify({ data: names.filter((n) => n[0] !== ".").sort(), mine: r("/data/mine.txt"), ws: r("/workspace/mine.txt"), tmp: r("/tmp/mine.txt") }));
  `);

describe("isolation: sandbox (one sandbox per script, several scripts per worker)", () => {
  it("runs 8 scripts on 2 workers of 4 slots, each seeing only its own files", async () => {
    const { spawn, counts } = spawner();
    const pool = createIsolatedPool({
      spawn,
      image: { packages: ["wasmer/quickjs"] },
      size: 1,
      slots: 4,
      isolation: "sandbox",
      warmup: qjs("1"),
    });
    const files = Array.from({ length: 8 }, () => new MemFilesApi());
    for (const [i, f] of files.entries()) await writeText(f, `/in-${i}.txt`, `${i}`);
    const results = await Promise.all(
      files.map((f, i) => pool.run({ argv: probe(`s${i}`), files: f })),
    );
    results.forEach((r, i) => {
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        data: [`in-${i}.txt`, "mine.txt"],
        mine: `s${i}`,
        ws: `s${i}`,
        tmp: `s${i}`,
      });
    });
    for (const [i, f] of files.entries()) expect(await readText(f, "/mine.txt")).toBe(`s${i}`);
    expect(counts.spawned).toBeLessThanOrEqual(3); // 2 busy workers (+1 kept ready)
    await pool.close();
  });

  it("a script after another on the same worker sees nothing of it", async () => {
    const { spawn } = spawner();
    const pool = createIsolatedPool({
      spawn,
      image: { packages: ["wasmer/quickjs"] },
      size: 1,
      slots: 2,
      isolation: "sandbox",
    });
    await pool.run({ argv: probe("first"), files: new MemFilesApi() });
    const second = await pool.run({
      argv: qjs(
        `const [n] = os.readdir("/data"); print(JSON.stringify([n.filter((x) => x[0] !== "."), !!std.open("/workspace/mine.txt", "r"), !!std.open("/tmp/mine.txt", "r")]))`,
      ),
      files: new MemFilesApi(),
    });
    expect(JSON.parse(second.stdout)).toEqual([[], false, false]);
    expect(pool.containers).toBe(1); // the same worker served both
    await pool.close();
  });

  it("a timed-out script retires its worker: its siblings finish, then the worker is terminated", async () => {
    const { spawn, counts } = spawner();
    const pool = createIsolatedPool({
      spawn,
      image: { packages: ["wasmer/quickjs"] },
      size: 1,
      slots: 2,
      isolation: "sandbox",
      warmup: qjs("1"),
    });
    await pool.ready();
    const spin = pool.run({ argv: qjs("while (true) {}"), timeoutMs: 1000 });
    const sibling = pool.run({ argv: qjs("os.sleep(1500); print('sibling done')") });
    expect((await spin).timedOut).toBe(true);
    expect((await sibling).stdout).toBe("sibling done\n");
    await new Promise((r) => setTimeout(r, 500));
    expect(counts.terminated).toBeGreaterThanOrEqual(1);
    const c0 = cpuMs();
    await new Promise((r) => setTimeout(r, 1500));
    expect(cpuMs() - c0).toBeLessThan(500); // the runaway went with its worker
    await pool.close();
  });
});

describe("isolation: shared (one sandbox per worker, bound to a capabilities key)", () => {
  it("runs with the same key share a container; runs with another key never do", async () => {
    const { spawn } = spawner();
    const pool = createIsolatedPool({
      spawn,
      image: { packages: ["wasmer/quickjs"] },
      size: 1,
      slots: 4,
      isolation: "shared",
    });
    const alice = new MemFilesApi();
    const bob = new MemFilesApi();
    await pool.run({ argv: probe("alice-1"), files: alice, capabilities: "alice" });
    const alice2 = await pool.run({
      argv: qjs(
        `const f = std.open("/workspace/mine.txt", "r"); print(f ? f.readAsString() : "none")`,
      ),
      files: alice,
      capabilities: "alice",
    });
    expect(alice2.stdout).toBe("alice-1\n"); // same key, same container: /workspace is shared by design
    const bob1 = await pool.run({
      argv: qjs(
        `const f = std.open("/workspace/mine.txt", "r"); const [n] = os.readdir("/data"); print(JSON.stringify([f ? f.readAsString() : null, n.filter((x) => x[0] !== ".")]))`,
      ),
      files: bob,
      capabilities: "bob",
    });
    expect(JSON.parse(bob1.stdout)).toEqual([null, []]); // another key: another container
    expect(pool.containers).toBe(2);
    await pool.close();
  });

  it("refuses a run without a capabilities key, or with other files than its key's", async () => {
    const { spawn } = spawner();
    const pool = createIsolatedPool({
      spawn,
      image: { packages: ["wasmer/quickjs"] },
      size: 1,
      slots: 2,
      isolation: "shared",
    });
    await expect(pool.run({ argv: qjs("1") })).rejects.toThrow(/capabilities/);
    const files = new MemFilesApi();
    await pool.run({ argv: qjs("1"), files, capabilities: "k" });
    await expect(
      pool.run({ argv: qjs("1"), files: new MemFilesApi(), capabilities: "k" }),
    ).rejects.toThrow(/files/);
    await pool.close();
  });
});
