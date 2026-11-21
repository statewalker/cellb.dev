// The engine in a worker thread, the cells' side holding a proxy with the same interface.
// Wasmer's core (package compile, VFS, scheduler) then never runs on the cells' thread.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainer } from "../src/container.ts";
import type { ContainerEngine } from "../src/engine.ts";
import { connectEngine } from "../src/rpc.ts";

const SERVER = `
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = ("hello " + self.path).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer(("0.0.0.0", 8080), H).serve_forever()
`;
const UPPER = "import sys\nfor line in sys.stdin:\n    print(line.strip().upper(), flush=True)";

let worker: Worker;
let engine: ContainerEngine;
beforeAll(async () => {
  worker = new Worker(new URL("./fixtures/engine-worker.ts", import.meta.url));
  const port = await new Promise<MessagePort>((resolve) =>
    worker.once("message", (m) => resolve(m.port)),
  );
  engine = connectEngine(port);
});
afterAll(async () => {
  await engine?.close();
  await worker?.terminate();
});

async function* lines(stream: ReadableStream<Uint8Array>) {
  let buf = "";
  for await (const chunk of stream.pipeThrough(
    new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
  )) {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
}

describe("connectEngine / serveEngine", () => {
  it("runs a container in the worker: fetch, connect, exec, destroy", async () => {
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const c = createContainer(engine, {
      packages: ["python/python"],
      files: { "s.py": SERVER },
      entrypoint: ["python", "/workspace/s.py"],
    });
    await c.start();
    await c.waitForPort(8080);
    delay.disable();
    expect(await (await c.getTcpPort(8080).fetch("http://c/rpc")).text()).toBe("hello /rpc");
    const sock = c.getTcpPort(8080).connect();
    const w = sock.writable.getWriter();
    await w.write(new TextEncoder().encode("GET /sock HTTP/1.0\r\n\r\n"));
    await w.close();
    expect(await new Response(sock.readable).text()).toContain("hello /sock");
    expect(await c.exec(["python", "-c", "print('exec ok')"])).toMatchObject({
      exitCode: 0,
      stdout: "exec ok\n",
    });
    expect(engine.running).toBe(1);
    await c.destroy();
    expect(c.running).toBe(false);
    // The cells' thread stays responsive while the worker compiles and starts Python.
    expect(delay.max / 1e6).toBeLessThan(250);
  });

  it("streams an interactive process's stdin and stdout across threads", async () => {
    const c = createContainer(engine, { packages: ["python/python"] });
    await c.start();
    const p = await c.spawn(["python", "-u", "-c", UPPER]);
    const w = p.stdin.getWriter();
    const out = lines(p.stdout);
    const got: string[] = [];
    for (const word of ["one", "two", "three"]) {
      await w.write(new TextEncoder().encode(`${word}\n`));
      got.push((await out.next()).value as string);
    }
    await w.close();
    expect(got).toEqual(["ONE", "TWO", "THREE"]);
    expect(await p.wait()).toMatchObject({ exitCode: 0 });
    await c.destroy();
  });

  it("reports a failing start as a rejected promise", async () => {
    const c = createContainer(engine, { packages: ["no-such-namespace/no-such-package-xyz"] });
    await expect(c.start()).rejects.toThrow();
    expect(c.running).toBe(false);
  });
});
