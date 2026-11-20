// ctx.container (Cloudflare's container API, as celld implements it) over a ContainerEngine.
import { Wasmer } from "@wasmer/sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainer } from "../src/container.ts";
import type { ContainerEngine, ContainerHandle, ContainerSpec } from "../src/engine.ts";
import { wasmerContainerEngine } from "../src/engine.ts";

/** A fake engine that records starts; its containers exit when told. */
function fakeEngine() {
  const starts: ContainerSpec[] = [];
  const handles: (ContainerHandle & { exit(code: number): void })[] = [];
  const engine: ContainerEngine = {
    running: 0,
    async start(spec) {
      starts.push(spec);
      let running = true;
      let exit!: (code: number) => void;
      const exited = new Promise<{ exitCode: number; reason: string }>((r) => {
        exit = (exitCode) => {
          running = false;
          r({ exitCode, reason: "exited" });
        };
      });
      const h = {
        get running() {
          return running;
        },
        monitor: () => exited,
        exit,
        waitForPort: async () => {},
        fetch: async (_p: number, req: Request) =>
          new Response(`fake ${new URL(req.url).pathname}`),
        connect: () => ({
          readable: new ReadableStream(),
          writable: new WritableStream(),
          close() {},
        }),
        exec: async (argv: string[]) => ({ exitCode: 0, stdout: argv.join(" "), stderr: "" }),
        signal: async () => exit(143),
        destroy: async () => exit(137),
      };
      handles.push(h);
      return h;
    },
    async close() {},
  };
  return { engine, starts, handles };
}

const IMAGE = { packages: ["python/python"], entrypoint: ["python", "/workspace/server.py"] };

describe("createContainer (unit)", () => {
  it("is not running before start(), and calls fail with a clear error", async () => {
    const { engine } = fakeEngine();
    const c = createContainer(engine, IMAGE);
    expect(c.running).toBe(false);
    await expect(c.getTcpPort(8080).fetch("http://c/")).rejects.toThrow(/not running/);
  });

  it("start() merges options over the image and runs once even if called twice", async () => {
    const { engine, starts } = fakeEngine();
    const c = createContainer(engine, IMAGE, { label: "alpha" });
    await Promise.all([c.start({ env: { A: "1" } }), c.start()]);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      entrypoint: IMAGE.entrypoint,
      env: { A: "1" },
      enableInternet: false,
      label: "alpha",
    });
    expect(c.running).toBe(true);
    expect(await (await c.getTcpPort(8080).fetch("http://c/hi")).text()).toBe("fake /hi");
  });

  it("monitor() settles when the container exits, and the object can start again", async () => {
    const { engine, starts, handles } = fakeEngine();
    const c = createContainer(engine, IMAGE);
    await c.start();
    const m = c.monitor();
    handles[0].exit(3);
    expect(await m).toMatchObject({ exitCode: 3 });
    expect(c.running).toBe(false);
    await c.start();
    expect(starts).toHaveLength(2);
  });

  it("destroy() stops the container; signal() is forwarded", async () => {
    const { engine } = fakeEngine();
    const c = createContainer(engine, IMAGE);
    await c.start();
    await c.signal(15);
    expect(c.running).toBe(false);
    await c.start();
    await c.destroy();
    expect(c.running).toBe(false);
  });

  it("refuses enableInternet until an egress policy exists", async () => {
    const { engine } = fakeEngine();
    const c = createContainer(engine, IMAGE);
    await expect(c.start({ enableInternet: true })).rejects.toThrow(/enableInternet/);
  });
});

const SERVER = `
import http.server, json, os, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b = json.dumps({"path": self.path, "cell": os.environ.get("CELL")}).encode()
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); b = self.rfile.read(n)[::-1]
        self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
socketserver.TCPServer(("0.0.0.0", 8080), H).serve_forever()
`;

describe("wasmerContainerEngine + createContainer (Python in WASIX)", () => {
  let wasmer: Wasmer;
  let engine: ContainerEngine;
  beforeAll(() => {
    wasmer = new Wasmer({ cache: { directory: ".wasmer" } });
    engine = wasmerContainerEngine(wasmer);
  });
  afterAll(async () => {
    await engine.close();
    await wasmer.close();
  });

  it("serves HTTP through getTcpPort().fetch() and a raw socket through connect()", async () => {
    const c = createContainer(engine, { ...IMAGE, files: { "server.py": SERVER } }, { label: "a" });
    await c.start({ env: { CELL: "a" } });
    await c.waitForPort(8080);
    const port = c.getTcpPort(8080);
    expect(await (await port.fetch("http://container/x?y=1")).json()).toEqual({
      path: "/x?y=1",
      cell: "a",
    });
    expect(
      await (await port.fetch("http://container/", { method: "POST", body: "wasix" })).text(),
    ).toBe("xisaw");
    const sock = port.connect();
    const w = sock.writable.getWriter();
    await w.write(new TextEncoder().encode("GET /raw HTTP/1.0\r\n\r\n"));
    await w.close();
    expect((await new Response(sock.readable).text()).split("\r\n")[0]).toBe("HTTP/1.0 200 OK");
    expect(await c.exec(["python", "-c", "print(6*7)"])).toMatchObject({
      exitCode: 0,
      stdout: "42\n",
    });
    await c.destroy();
    expect(c.running).toBe(false);
  });

  it("isolates containers: one cannot reach another's port", async () => {
    const a = createContainer(engine, { ...IMAGE, files: { "server.py": SERVER } });
    const b = createContainer(engine, { packages: ["python/python"] });
    await a.start();
    await a.waitForPort(8080);
    await b.start();
    const probe =
      "import socket\ntry:\n    socket.create_connection(('127.0.0.1', 8080), 2); print('reached')\nexcept Exception as e: print('refused')";
    expect((await b.exec(["python", "-c", probe])).stdout.trim()).toBe("refused");
    await a.destroy();
    await b.destroy();
  });

  it("destroy() kills processes started with exec(), not only the main process", async () => {
    const c = createContainer(engine, { packages: ["python/python"] });
    await c.start();
    // A sleeping guest makes system calls, so kill() reaches it. (A pure compute loop does not
    // yield and needs its worker terminated: see pool-recycle.test.ts.)
    const spinning = c.exec(["python", "-c", "import time\ntime.sleep(60)"]);
    await new Promise((r) => setTimeout(r, 1000));
    await c.destroy();
    const settled = await Promise.race([
      spinning.then(
        (r) => `exit ${r.exitCode}`,
        () => "rejected",
      ),
      new Promise((r) => setTimeout(() => r("still running"), 5000)),
    ]);
    expect(settled).not.toBe("still running");
  });

  it("close() destroys every container of the engine", async () => {
    const own = wasmerContainerEngine(wasmer);
    const c = createContainer(own, { ...IMAGE, files: { "server.py": SERVER } });
    await c.start();
    expect(own.running).toBe(1);
    await own.close();
    expect(own.running).toBe(0);
    expect(c.running).toBe(false);
  });
});
