// Several scripts in one Wasmer client (one "core"): is each script's data its own?
// - each script in a sandbox of its own, with its own FilesApi mounted: verified isolated, and
//   the scripts run at the same time;
// - several processes in one sandbox share its mounts and /workspace (each has its own /tmp and
//   root): only scripts with the same capabilities (the same FilesApi view) may share a sandbox;
// - Lifo runs one command at a time per box (N = 1).
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ContainerEngine, wasmerContainerEngine } from "../src/engine.ts";
import { HostMounts, installHostFiles } from "../src/files/bridge.ts";
import { createIsolatedPool } from "../src/isolated-pool.ts";

// QuickJS (wasmer/quickjs), with std/os as globals.
const qjs = (code: string) => ["qjs", "--std", "-e", code];
// Each script: writes its secret to its /data and to /tmp, sleeps (so the scripts overlap),
// then reports what it can see.
const script = (secret: string) =>
  qjs(`
    const w = (p, s) => { const f = std.open(p, "w"); f.puts(s); f.close(); };
    const r = (p) => { const f = std.open(p, "r"); if (!f) return null; const s = f.readAsString(); f.close(); return s; };
    w("/data/mine.txt", "${secret}");
    w("/tmp/shared.txt", "${secret}");
    os.sleep(400);
    const [names] = os.readdir("/data");
    print(JSON.stringify({
      data: names.filter((n) => n !== "." && n !== "..").sort(),
      mine: r("/data/mine.txt"),
      tmp: r("/tmp/shared.txt"),
      env: std.getenv("SECRET") ?? null,
    }));
  `);

let wasmer: Wasmer;
let engine: ContainerEngine;
let mounts: HostMounts;
let uninstall: () => void;
beforeAll(() => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  engine = wasmerContainerEngine(wasmer);
  mounts = new HostMounts();
  uninstall = installHostFiles(mounts);
});
afterAll(async () => {
  uninstall?.();
  await engine?.close();
  await wasmer?.close();
});

describe("several scripts in one Wasmer client", () => {
  it("one sandbox per script: each sees only its own FilesApi, /tmp and env, while they run at once", async () => {
    const N = 6;
    const files = Array.from({ length: N }, () => new MemFilesApi());
    for (const [i, f] of files.entries()) await writeText(f, `/input-${i}.txt`, `input ${i}`);
    const t0 = performance.now();
    const results = await Promise.all(
      files.map(async (f, i) => {
        const id = mounts.add(f);
        const h = await engine.start({
          packages: ["wasmer/quickjs"],
          mounts: [{ path: "/data", id }],
        });
        try {
          const r = await h.exec(script(`secret-${i}`), { env: { SECRET: `env-${i}` } });
          expect(r.stderr).toBe("");
          return JSON.parse(r.stdout);
        } finally {
          await h.destroy();
          mounts.remove(id);
        }
      }),
    );
    const wallMs = performance.now() - t0;
    results.forEach((r, i) => {
      expect(r).toEqual({
        data: [`input-${i}.txt`, "mine.txt"],
        mine: `secret-${i}`,
        tmp: `secret-${i}`,
        env: `env-${i}`,
      });
    });
    for (const [i, f] of files.entries())
      expect(await readText(f, "/mine.txt")).toBe(`secret-${i}`);
    // They overlapped: six 400 ms sleeps finished well under 6 x 400 ms.
    expect(wallMs).toBeLessThan(N * 400);
  });

  it("several processes in one sandbox share its mounts and /workspace (only /tmp is per process): only for scripts with the same capabilities", async () => {
    const shared = new MemFilesApi();
    const id = mounts.add(shared);
    const h = await engine.start({ packages: ["wasmer/quickjs"], mounts: [{ path: "/data", id }] });
    const paths = ["/data/x", "/workspace/x", "/tmp/x"];
    const writer = qjs(
      `for (const p of ${JSON.stringify(paths)}) { const f = std.open(p, "w"); f.puts("from writer"); f.close(); } os.sleep(1000);`,
    );
    const reader = qjs(
      `os.sleep(300); const o = {}; for (const p of ${JSON.stringify(paths)}) { const f = std.open(p, "r"); o[p] = f ? f.readAsString() : null; f && f.close(); } print(JSON.stringify(o));`,
    );
    try {
      const [, r] = await Promise.all([h.exec(writer), h.exec(reader)]);
      expect(JSON.parse(r.stdout)).toEqual({
        "/data/x": "from writer",
        "/workspace/x": "from writer",
        "/tmp/x": null,
      });
    } finally {
      await h.destroy();
      mounts.remove(id);
    }
  });
});

describe("Lifo: one command at a time per box", () => {
  it("two commands sent at once run one after the other", async () => {
    const pool = createIsolatedPool({
      spawn: () => new Worker(new URL("./fixtures/isolated-lifo-worker.ts", import.meta.url)),
      image: { packages: [] },
      size: 1,
    });
    const c = await pool.acquire();
    const sleep = ["node", "-e", "const t=Date.now(); while (Date.now()-t < 400) {}"];
    const t0 = performance.now();
    await Promise.all([c.exec(sleep), c.exec(sleep)]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(780);
    await c.destroy();
    await pool.close();
  });
});
