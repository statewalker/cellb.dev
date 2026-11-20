// ctx.container in the core: objects of a `containers` class get Cloudflare's container API, on
// the container engine the host provides (Wasmer in @statewalker/cellb-containers; a fake here).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerEngine, ContainerHandle, ContainerSpec } from "../src/container.js";
import { createCellRuntime, DurableObject } from "../src/index.js";
import { buildProject, loadNodeProject, nodeSqliteOpener } from "../src/node.js";

/** An engine whose containers answer HTTP with what they were started with. */
function fakeEngine() {
  const starts: ContainerSpec[] = [];
  const destroyed: string[] = [];
  let live = 0;
  const engine: ContainerEngine = {
    get running() {
      return live;
    },
    async start(spec) {
      starts.push(spec);
      live++;
      let running = true;
      let exit!: (r: { exitCode: number; reason: string }) => void;
      const exited = new Promise<{ exitCode: number; reason: string }>((r) => {
        exit = r;
      });
      const handle: ContainerHandle = {
        get running() {
          return running;
        },
        monitor: () => exited,
        waitForPort: async () => {},
        fetch: async (_port, req) =>
          Response.json({
            path: new URL(req.url).pathname,
            env: spec.env,
            files: spec.files,
            label: spec.label,
          }),
        connect: () => ({
          readable: new ReadableStream(),
          writable: new WritableStream(),
          close() {},
        }),
        exec: async (argv) => ({ exitCode: 0, stdout: argv.join(" "), stderr: "" }),
        signal: async () => {},
        destroy: async () => {
          if (!running) return;
          running = false;
          live--;
          destroyed.push(spec.label ?? "");
          exit({ exitCode: 137, reason: "terminated" });
        },
      };
      return handle;
    },
    async close() {},
  };
  return { engine, starts, destroyed };
}

class Runner extends DurableObject {
  async fetch(req: Request) {
    const c = (this.ctx as any).container;
    if (!c) return new Response("no container", { status: 500 });
    const url = new URL(req.url);
    if (url.pathname === "/timeout") {
      c.setInactivityTimeout(Number(url.searchParams.get("ms")));
      return new Response("ok");
    }
    if (!c.running) await c.start({ env: { CELL: this.ctx.id.name } });
    return c.getTcpPort(8080).fetch(`http://container${url.pathname}`);
  }
}
class Plain extends DurableObject {
  async fetch() {
    return Response.json({
      hasContainer: "container" in this.ctx && (this.ctx as any).container !== undefined,
    });
  }
}

const image = {
  packages: ["python/python"],
  entrypoint: ["python", "/workspace/s.py"],
  files: { "s.py": "print(1)" },
};

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

function runtimeWith(engine: ContainerEngine) {
  const runtime = createCellRuntime({
    worker: {
      Runner,
      Plain,
      default: {
        fetch: (req: Request, env: any) => {
          const url = new URL(req.url);
          const ns = url.searchParams.get("class") === "plain" ? env.PLAIN : env.RUNNER;
          return ns.getByName(url.searchParams.get("name") ?? "a").fetch(req);
        },
      },
    },
    durableObjects: { RUNNER: { className: "Runner" }, PLAIN: { className: "Plain" } },
    openSql: nodeSqliteOpener(),
    containers: { engine, images: { Runner: image } },
  });
  closers.push(() => runtime.close());
  return runtime;
}

describe("ctx.container (createCellRuntime)", () => {
  it("objects of a container class get ctx.container on the host's engine; others do not", async () => {
    const { engine, starts } = fakeEngine();
    const runtime = runtimeWith(engine);
    const r = await (await runtime.fetch(new Request("http://x/hello?name=alpha"))).json();
    expect(r).toEqual({
      path: "/hello",
      env: { CELL: "alpha" },
      files: image.files,
      label: "alpha",
    });
    expect(starts[0]).toMatchObject({ packages: image.packages, entrypoint: image.entrypoint });
    expect(await (await runtime.fetch(new Request("http://x/?class=plain"))).json()).toEqual({
      hasContainer: false,
    });
  });

  it("each cell has its own container, and keeps it across its object's instances", async () => {
    const { engine, starts } = fakeEngine();
    const runtime = runtimeWith(engine);
    await runtime.fetch(new Request("http://x/?name=alpha"));
    await runtime.fetch(new Request("http://x/?name=beta"));
    await runtime.fetch(new Request("http://x/?name=alpha"));
    expect(starts.map((s) => s.label)).toEqual(["alpha", "beta"]);
  });

  it("close() destroys the runtime's containers", async () => {
    const { engine, destroyed } = fakeEngine();
    const runtime = createCellRuntime({
      worker: {
        Runner,
        default: { fetch: (req: Request, env: any) => env.RUNNER.getByName("a").fetch(req) },
      },
      durableObjects: { RUNNER: { className: "Runner" } },
      openSql: nodeSqliteOpener(),
      containers: { engine, images: { Runner: image } },
    });
    await runtime.fetch(new Request("http://x/"));
    await runtime.close();
    expect(destroyed).toEqual(["a"]);
  });

  it("a container with no call for its inactivity timeout is destroyed", async () => {
    const { engine, destroyed } = fakeEngine();
    const runtime = runtimeWith(engine);
    await runtime.fetch(new Request("http://x/?name=idle"));
    await runtime.fetch(new Request("http://x/timeout?name=idle&ms=60"));
    await new Promise((r) => setTimeout(r, 150));
    expect(destroyed).toEqual(["idle"]);
  });
});

describe("containers in a project (wrangler `containers` + `cellb.containers`)", () => {
  function project(withImage: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "cellb-containers-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "server.py"), "print('hello from a file')");
    writeFileSync(
      join(dir, "index.js"),
      `import { DurableObject } from "cloudflare:workers";
       export class Runner extends DurableObject {
         async fetch(req) {
           const c = this.ctx.container;
           if (!c) return new Response("no container", { status: 500 });
           if (!c.running) await c.start();
           return c.getTcpPort(8080).fetch(req.url);
         }
       }
       export default { fetch: (req, env) => env.RUNNER.getByName("a").fetch(req) };`,
    );
    writeFileSync(
      join(dir, "wrangler.json"),
      JSON.stringify({
        name: "containers-test",
        main: "index.js",
        compatibility_date: "2026-01-01",
        durable_objects: { bindings: [{ name: "RUNNER", class_name: "Runner" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["Runner"] }],
        containers: [{ class_name: "Runner", image: "./Dockerfile" }],
        ...(withImage && {
          cellb: {
            containers: {
              Runner: {
                packages: ["python/python"],
                files: { "server.py": "./app/server.py", "inline.txt": "inline" },
                entrypoint: ["python", "/workspace/server.py"],
              },
            },
          },
        }),
      }),
    );
    return dir;
  }

  it("runs a container class when the host has an engine and the class an image; file references are read", async () => {
    const { engine, starts } = fakeEngine();
    const { runtime, unsupported } = await loadNodeProject(project(true), {
      openSql: nodeSqliteOpener(),
      files: undefined as never,
      containers: engine,
    });
    closers.push(() => runtime.close());
    expect(unsupported.filter((u) => u.startsWith("containers"))).toEqual([]);
    const r = await (await runtime.fetch(new Request("http://x/hi"))).json();
    expect(r.path).toBe("/hi");
    expect(starts[0].files).toEqual({
      "server.py": "print('hello from a file')",
      "inline.txt": "inline",
    });
  });

  it("still reports a container class without an image, or without an engine", async () => {
    const noImage = await loadNodeProject(project(false), {
      openSql: nodeSqliteOpener(),
      files: undefined as never,
      containers: fakeEngine().engine,
    });
    closers.push(() => noImage.runtime.close());
    expect(noImage.unsupported.join()).toMatch(/containers\[Runner\].*cellb\.containers/);
    const noEngine = await loadNodeProject(project(true), {
      openSql: nodeSqliteOpener(),
      files: undefined as never,
    });
    closers.push(() => noEngine.runtime.close());
    expect(noEngine.unsupported.join()).toMatch(/containers\[Runner\].*engine/);
  });

  it("cellb build puts the image's files into the built wrangler.json", async () => {
    const out = mkdtempSync(join(tmpdir(), "cellb-containers-built-"));
    await buildProject(project(true), out);
    const built = JSON.parse(readFileSync(join(out, "wrangler.json"), "utf8"));
    expect(built.cellb.containers.Runner.files).toEqual({
      "server.py": "print('hello from a file')",
      "inline.txt": "inline",
    });
  });
});
