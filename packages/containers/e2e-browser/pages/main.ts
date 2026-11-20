// The page: owns the FilesApi (on the main thread) and drives containers through the engine
// worker. Each window.__* function is one scenario; the spec asserts on what it returns.
import { readText, writeText } from "@statewalker/webrun-files";
import {
  FilteredFilesApi,
  GuardedFilesApi,
  newPathFilter,
} from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createContainer } from "../../src/container.ts";
import { HostMounts, serveHostFiles } from "../../src/files/bridge.ts";
import { connectEngine } from "../../src/rpc.ts";

const files = new MemFilesApi();
const mounts = new HostMounts();
const mountId = mounts.add(
  new GuardedFilesApi(new FilteredFilesApi(files, newPathFilter("/secret")), [
    {
      operations: ["write", "remove", "move", "mkdir", "copy"],
      check: (p: string) => !p.startsWith("/docs"),
      message: "read-only",
    },
  ]),
);
const engineChannel = new MessageChannel();
const filesChannel = new MessageChannel();
serveHostFiles(filesChannel.port1, mounts);
const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), { type: "module" });
worker.postMessage({ engine: engineChannel.port2, files: filesChannel.port2 }, [
  engineChannel.port2,
  filesChannel.port2,
]);
const engine = connectEngine(engineChannel.port1);

const SERVER = `
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = ("hello " + self.path).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer(("0.0.0.0", 8080), H).serve_forever()
`;

// Longest gap of a 10 ms timer: how long the page could not respond.
let maxGap = 0;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
}, 10);

Object.assign(window, {
  async __http() {
    maxGap = 0;
    const c = createContainer(engine, {
      packages: ["python/python"],
      files: { "s.py": SERVER },
      entrypoint: ["python", "/workspace/s.py"],
    });
    await c.start();
    await c.waitForPort(8080);
    const text = await (await c.getTcpPort(8080).fetch("http://c/browser")).text();
    const exec = await c.exec(["python", "-c", "import platform; print(platform.machine())"]);
    await c.destroy();
    return { crossOriginIsolated, text, exec, running: c.running, maxGapMs: Math.round(maxGap) };
  },

  async __files() {
    await writeText(files, "/docs/a.txt", "hello from the page");
    await writeText(files, "/secret/key.txt", "s3cr3t");
    const c = createContainer(engine, {
      packages: ["python/python"],
      mounts: [{ path: "/data", id: mountId }],
    });
    await c.start();
    const script = [
      "import json, os",
      "r = {'list': sorted(os.listdir('/data')), 'read': open('/data/docs/a.txt').read(), 'secret': os.path.exists('/data/secret/key.txt')}",
      "try:\n    open('/data/docs/a.txt', 'w').write('X'); r['docsWrite'] = 'ok'\nexcept Exception as e:\n    r['docsWrite'] = type(e).__name__",
      "os.makedirs('/data/out', exist_ok=True)",
      "open('/data/out/py.txt', 'w').write('written by python in a worker')",
      "print(json.dumps(r))",
    ].join("\n");
    const run = await c.exec(["python", "-c", script]);
    await c.destroy();
    return {
      guest: JSON.parse(run.stdout || "null"),
      stderr: run.stderr,
      pageSees: await readText(files, "/out/py.txt"),
      docsAfter: await readText(files, "/docs/a.txt"),
    };
  },

  async __cellb(paths: string[]) {
    const w = new Worker(new URL("./cellb-worker.ts", import.meta.url), { type: "module" });
    const { port1, port2 } = new MessageChannel();
    const done = new Promise((resolve) => (port1.onmessage = (e) => resolve(e.data)));
    w.postMessage({ paths }, [port2]);
    const r = await done;
    w.terminate();
    return r;
  },
});
document.body.dataset.ready = "true";
