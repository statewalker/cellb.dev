// A pool of containers for running custom code: each run gets a fresh, pre-started sandbox and
// its own FilesApi, and nothing of a run (its files, /workspace, /tmp, environment) reaches the next.
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerEngine } from "../src/engine.ts";
import { wasmerContainerEngine } from "../src/engine.ts";
import { HostMounts, installHostFiles } from "../src/files/bridge.ts";
import { type ContainerPool, createContainerPool } from "../src/pool.ts";

const py = (code: string) => ["python", "-c", code];

let wasmer: Wasmer;
let engine: ContainerEngine;
let mounts: HostMounts;
let uninstall: () => void;
let pool: ContainerPool;
beforeAll(async () => {
  wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
  engine = wasmerContainerEngine(wasmer);
  mounts = new HostMounts();
  uninstall = installHostFiles(mounts);
  pool = createContainerPool(engine, mounts, { image: { packages: ["python/python"] }, size: 2 });
  await pool.warm();
});
afterAll(async () => {
  await pool?.close();
  uninstall?.();
  await engine?.close();
  await wasmer?.close();
});

describe("createContainerPool", () => {
  it("keeps `size` sandboxes started and ready", async () => {
    expect(pool.idle).toBe(2);
    expect(pool.busy).toBe(0);
  });

  it("runs code against the run's own FilesApi, mounted at /data", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/in.txt", "three little words");
    const r = await pool.run({
      argv: py(
        "import os\nw = open('/data/in.txt').read().split()\nopen('/data/out.txt','w').write(str(len(w)))\nprint(sorted(os.listdir('/data')))",
      ),
      files,
    });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.stdout.trim()).toBe("['in.txt', 'out.txt']");
    expect(await readText(files, "/out.txt")).toBe("3");
  });

  it("leaks nothing between runs: files, /workspace, /tmp, environment", async () => {
    const a = new MemFilesApi();
    const b = new MemFilesApi();
    await writeText(b, "/b-input.txt", "b");
    const first = await pool.run({
      argv: py(
        [
          "import os",
          "open('/workspace/leak.txt','w').write('from a')",
          "open('/tmp/leak.txt','w').write('from a')",
          "open('/data/a-only.txt','w').write('secret of a')",
          "print(os.environ.get('SECRET'))",
        ].join("\n"),
      ),
      files: a,
      env: { SECRET: "a-secret" },
    });
    expect(first.stdout.trim()).toBe("a-secret");
    const second = await pool.run({
      argv: py(
        [
          "import json, os",
          "print(json.dumps({",
          "  'data': sorted(os.listdir('/data')),",
          "  'workspace': os.path.exists('/workspace/leak.txt'),",
          "  'tmp': os.path.exists('/tmp/leak.txt'),",
          "  'secret': os.environ.get('SECRET'),",
          "}))",
        ].join("\n"),
      ),
      files: b,
    });
    expect(JSON.parse(second.stdout)).toEqual({
      data: ["b-input.txt"],
      workspace: false,
      tmp: false,
      secret: null,
    });
    expect(await a.exists("/b-input.txt")).toBe(false);
    expect(await b.exists("/a-only.txt")).toBe(false);
    expect(await readText(a, "/a-only.txt")).toBe("secret of a");
  });

  it("unbinds a run's FilesApi when the run ends", async () => {
    const before = mounts.size;
    await pool.run({ argv: py("print(1)"), files: new MemFilesApi() });
    expect(mounts.size).toBe(before);
  });

  it("runs at most `size` at once, each against its own FilesApi", async () => {
    let peak = 0;
    const tick = setInterval(() => {
      peak = Math.max(peak, pool.busy);
    }, 20);
    const fss = Array.from({ length: 5 }, () => new MemFilesApi());
    const results = await Promise.all(
      fss.map((files, i) =>
        pool.run({
          argv: py(
            `import time\ntime.sleep(0.5)\nopen('/data/mine.txt','w').write('run ${i}')\nprint(len(__import__('os').listdir('/data')))`,
          ),
          files,
        }),
      ),
    );
    clearInterval(tick);
    expect(results.map((r) => r.stdout.trim())).toEqual(["1", "1", "1", "1", "1"]);
    expect(await Promise.all(fss.map((f) => readText(f, "/mine.txt")))).toEqual([
      "run 0",
      "run 1",
      "run 2",
      "run 3",
      "run 4",
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops a run that exceeds its timeout, and keeps serving", async () => {
    // A guest that makes system calls (sleep, I/O) is stopped by kill(); one in a pure compute
    // loop is not, and needs a recyclable engine (pool-recycle.test.ts).
    const r = await pool.run({ argv: py("import time\ntime.sleep(60)"), timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    const next = await pool.run({ argv: py("print('still here')") });
    expect(next.stdout.trim()).toBe("still here");
  });

  it("a run without files sees no /data", async () => {
    const r = await pool.run({ argv: py("import os\nprint(os.path.exists('/data/x'))") });
    expect(r.stdout.trim()).toBe("False");
  });
});
