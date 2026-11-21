// One contract, several runtimes: the same pool API and the same guarantees, whatever runs the
// containers. Only the commands differ (Python for Wasmer, Node-compatible JS for Lifo).
import { Worker } from "node:worker_threads";
import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerSpec } from "../src/engine.ts";
import { createIsolatedPool, type IsolatedPool } from "../src/isolated-pool.ts";

interface Runtime {
  name: string;
  fixture: string;
  image: Omit<ContainerSpec, "mounts">;
  warmup?: string[];
  /** A server image: listens on 8080 and answers JSON with the request path. */
  server: Omit<ContainerSpec, "mounts">;
  cmd: {
    print42: string[];
    env: (name: string) => string[];
    upper: (from: string, to: string) => string[];
    leave: string[]; // writes /tmp/leak and /workspace/leak
    probe: string[]; // prints JSON [names in /data, /tmp/leak exists, /workspace/leak exists]
    spin: string[];
  };
}

const py = (code: string) => ["python", "-c", code];
const js = (code: string) => ["node", "-e", code];

const runtimes: Runtime[] = [
  {
    name: "wasmer",
    fixture: "./fixtures/isolated-wasmer-worker.ts",
    image: { packages: ["python/python"] },
    warmup: py("pass"),
    server: {
      packages: ["python/python"],
      files: {
        "s.py":
          "import http.server,json,socketserver\nclass H(http.server.BaseHTTPRequestHandler):\n  def do_GET(s):\n    b=json.dumps({'path':s.path}).encode();s.send_response(200);s.send_header('content-length',str(len(b)));s.end_headers();s.wfile.write(b)\n  def log_message(s,*a):pass\nsocketserver.TCPServer(('0.0.0.0',8080),H).serve_forever()",
      },
      entrypoint: ["python", "/workspace/s.py"],
    },
    cmd: {
      print42: py("print(6*7)"),
      env: (n) => py(`import os; print(os.environ.get('${n}'))`),
      upper: (a, b) => py(`open('${b}','w').write(open('${a}').read().upper())`),
      leave: py("open('/tmp/leak','w').write('x'); open('/workspace/leak','w').write('x')"),
      probe: py(
        "import os,json; print(json.dumps([sorted(os.listdir('/data')), os.path.exists('/tmp/leak'), os.path.exists('/workspace/leak')]))",
      ),
      spin: py("while True:\n    pass"),
    },
  },
  {
    name: "lifo",
    fixture: "./fixtures/isolated-lifo-worker.ts",
    image: { packages: [] },
    server: {
      packages: [],
      files: {
        "s.js":
          "require('http').createServer((q,r)=>{const b=JSON.stringify({path:q.url});r.writeHead(200,{'content-type':'application/json'});r.end(b)}).listen(8080)",
      },
      entrypoint: ["node", "/workspace/s.js"],
    },
    cmd: {
      print42: js("console.log(6*7)"),
      env: (n) => js(`console.log(process.env.${n} ?? 'None')`),
      upper: (a, b) =>
        js(
          `const fs=require('fs'); fs.writeFileSync('${b}', fs.readFileSync('${a}','utf8').toUpperCase())`,
        ),
      leave: js(
        "const fs=require('fs'); fs.writeFileSync('/tmp/leak','x'); fs.writeFileSync('/workspace/leak','x')",
      ),
      probe: js(
        "const fs=require('fs'); console.log(JSON.stringify([fs.readdirSync('/data').sort(), fs.existsSync('/tmp/leak'), fs.existsSync('/workspace/leak')]))",
      ),
      spin: js("while (true) {}"),
    },
  },
];

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

for (const rt of runtimes) {
  describe(`isolated pool contract: ${rt.name}`, () => {
    const spawn = () => new Worker(new URL(rt.fixture, import.meta.url));
    let pool: IsolatedPool;
    beforeAll(async () => {
      pool = createIsolatedPool({ spawn, image: rt.image, size: 2, warmup: rt.warmup });
      await pool.ready();
    });
    afterAll(async () => {
      await pool?.close();
    });

    it("runs a command in a ready container", async () => {
      expect(await pool.run({ argv: rt.cmd.print42 })).toMatchObject({
        exitCode: 0,
        stdout: "42\n",
        timedOut: false,
      });
    });

    it("passes the run's environment", async () => {
      expect((await pool.run({ argv: rt.cmd.env("WHO"), env: { WHO: "alice" } })).stdout).toBe(
        "alice\n",
      );
    });

    it("mounts the run's own FilesApi at /data", async () => {
      const files = new MemFilesApi();
      await writeText(files, "/in.txt", "from the host");
      const r = await pool.run({ argv: rt.cmd.upper("/data/in.txt", "/data/out.txt"), files });
      expect(r.exitCode).toBe(0);
      expect(await readText(files, "/out.txt")).toBe("FROM THE HOST");
    });

    it("leaks nothing between runs", async () => {
      const a = new MemFilesApi();
      await writeText(a, "/a-only.txt", "a");
      await pool.run({ argv: rt.cmd.leave, files: a });
      const b = new MemFilesApi();
      const r = await pool.run({ argv: rt.cmd.probe, files: b });
      expect(JSON.parse(r.stdout)).toEqual([[], false, false]);
    });

    it("hands out a running server with getTcpPort().fetch()", async () => {
      const servers = createIsolatedPool({ spawn, image: rt.server, size: 1 });
      const c = await servers.acquire();
      await c.waitForPort(8080, 30_000);
      expect(await (await c.getTcpPort(8080).fetch("http://container/hello?x=1")).json()).toEqual({
        path: "/hello?x=1",
      });
      await c.destroy();
      await servers.close();
    });

    it("stops a timed-out compute loop by terminating its worker", async () => {
      const r = await pool.run({ argv: rt.cmd.spin, timeoutMs: 1500 });
      expect(r.timedOut).toBe(true);
      await pool.ready();
      await new Promise((res) => setTimeout(res, 500));
      const c0 = cpuMs();
      await new Promise((res) => setTimeout(res, 2000));
      expect(cpuMs() - c0).toBeLessThan(600);
    });
  });
}
