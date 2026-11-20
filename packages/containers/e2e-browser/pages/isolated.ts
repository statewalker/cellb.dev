// The isolated pool in a page: one Web Worker per container; the FilesApis on this (main) thread.
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createIsolatedPool } from "../../src/isolated-pool.ts";

const runtimes = {
  wasmer: {
    spawn: () =>
      new Worker(new URL("./isolated-wasmer-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: ["python/python"] },
    warmup: ["python", "-c", "pass"],
    print: ["python", "-c", "print(6*7)"],
    upper: ["python", "-c", "open('/data/out.txt','w').write(open('/data/in.txt').read().upper())"],
    leave: ["python", "-c", "open('/tmp/leak','w').write('x')"],
    probe: [
      "python",
      "-c",
      "import os,json; print(json.dumps([os.listdir('/data'), os.path.exists('/tmp/leak')]))",
    ],
    spin: ["python", "-c", "while True:\n    pass"],
  },
  lifo: {
    spawn: () =>
      new Worker(new URL("./isolated-lifo-worker.ts", import.meta.url), { type: "module" }),
    image: { packages: [] },
    warmup: undefined,
    print: ["node", "-e", "console.log(6*7)"],
    upper: [
      "node",
      "-e",
      "const fs=require('fs'); fs.writeFileSync('/data/out.txt', fs.readFileSync('/data/in.txt','utf8').toUpperCase())",
    ],
    leave: ["node", "-e", "require('fs').writeFileSync('/tmp/leak','x')"],
    probe: [
      "node",
      "-e",
      "const fs=require('fs'); console.log(JSON.stringify([fs.readdirSync('/data'), fs.existsSync('/tmp/leak')]))",
    ],
    spin: ["node", "-e", "while (true) {}"],
  },
};

Object.assign(window, {
  async __isolated(name: keyof typeof runtimes) {
    const rt = runtimes[name];
    const pool = createIsolatedPool({
      spawn: rt.spawn,
      image: rt.image,
      size: 2,
      warmup: rt.warmup,
    });
    const t0 = performance.now();
    await pool.ready();
    const warmMs = Math.round(performance.now() - t0);
    const print = await pool.run({ argv: rt.print });
    const files = new MemFilesApi();
    await writeText(files, "/in.txt", "from the page");
    await pool.run({ argv: rt.upper, files });
    const upper = await readText(files, "/out.txt");
    await pool.run({ argv: rt.leave, files: new MemFilesApi() });
    const probeRun = await pool.run({ argv: rt.probe, files: new MemFilesApi() });
    let probe: unknown;
    try {
      probe = JSON.parse(probeRun.stdout);
    } catch {
      probe = { raw: probeRun.stdout, stderr: probeRun.stderr };
    }
    const queued = await Promise.all([1, 2, 3, 4].map(() => pool.run({ argv: rt.print })));
    const spin = await pool.run({ argv: rt.spin, timeoutMs: 1500 });
    const after = await pool.run({ argv: rt.print });
    await pool.close();
    return {
      warmMs,
      print,
      upper,
      probe,
      queued: queued.map((r) => r.stdout),
      spin: spin.timedOut,
      after: after.stdout,
    };
  },
});
