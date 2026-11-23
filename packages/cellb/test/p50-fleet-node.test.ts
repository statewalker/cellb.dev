import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { asyncContextFrameArgs } from "../src/cli.js";
import type { ContainerEngine, ContainerSpec } from "../src/container.js";
import { memoryObjectStore } from "../src/index.js";
import { loadContainerEngine, parseServeArgs, startFleetNode } from "../src/node.js";

// `cellb serve`: a cellb node that joins a celld fleet the way a celld node does — one bucket,
// celld's ownership records, celld's peer tunnel, a public HTTP listener (statewalker/cellb.dev#208).
const examples = join(__dirname, "../conformance/celld-examples");
const json = async (r: Response) => JSON.parse(await r.text());
const dec = new TextDecoder();

describe("P50 cellb serve: a fleet node", () => {
  it("parses celld's flags and environment", () => {
    expect(
      parseServeArgs(
        [
          "proj",
          "--bucket",
          "s3://cells/fleet-a",
          "--endpoint",
          "http://127.0.0.1:9200",
          "--listen",
          "127.0.0.1:8080",
          "--internal-listen",
          "127.0.0.1:0",
          "--advertise",
          "10.0.0.5:7000",
          "--node",
          "n1",
        ],
        {},
      ),
    ).toEqual({
      dir: "proj",
      bucket: { name: "cells", prefix: "fleet-a" },
      endpoint: "http://127.0.0.1:9200",
      region: "us-east-1",
      listen: "127.0.0.1:8080",
      internalListen: "127.0.0.1:0",
      advertise: "10.0.0.5:7000",
      node: "n1",
    });
    expect(
      parseServeArgs([], {
        CELLD_BUCKET: "cells",
        S3_ENDPOINT: "http://s3",
        AWS_REGION: "eu-west-3",
      }),
    ).toMatchObject({
      dir: ".",
      bucket: { name: "cells", prefix: "" },
      endpoint: "http://s3",
      region: "eu-west-3",
      listen: "127.0.0.1:8080",
    });
    expect(() => parseServeArgs(["proj"], {})).toThrow(/--bucket/);
    expect(() => parseServeArgs(["proj", "--bucket", "gs://x"], {})).toThrow(/s3/);
  });

  it("two nodes on one bucket serve every cell from its one owner, and hand it over on close", async () => {
    const store = memoryObjectStore();
    const dir = join(examples, "counter");
    const a = await startFleetNode({ dir, store, node: "a", listen: "127.0.0.1:0" });
    const b = await startFleetNode({ dir, store, node: "b", listen: "127.0.0.1:0" });
    try {
      expect((await json(await fetch(`${a.url}/increment?name=x`))).n).toBe(1);
      // b's request for a's cell crosses celld's peer tunnel to a
      expect((await json(await fetch(`${b.url}/increment?name=x`))).n).toBe(2);
      expect((await json(await fetch(`${a.url}/increment?name=x`))).n).toBe(3);
      const owners = await Promise.all(
        (await store.list("cells/"))
          .filter((k) => k.endsWith("/own.json"))
          .map(async (k) => JSON.parse(dec.decode((await store.get(k))!.body)).node),
      );
      expect(owners).toEqual(["a"]);
      // the node record carries the peer address celld dials
      const rec = JSON.parse(dec.decode((await store.get("nodes/a.json"))!.body));
      expect(rec.addr).toBe(a.addr);
      await a.close();
      // a released its cell: b takes it at once
      expect((await json(await fetch(`${b.url}/increment?name=x`))).n).toBe(4);
      expect(await store.get("nodes/a.json")).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("a request sent on a kept-alive connection as the node leaves is answered (statewalker/cellb.dev#222)", async () => {
    const http = await import("node:http");
    const store = memoryObjectStore();
    const dir = join(examples, "counter");
    const a = await startFleetNode({ dir, store, node: "a", listen: "127.0.0.1:0" });
    const b = await startFleetNode({ dir, store, node: "b", listen: "127.0.0.1:0" });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    const get = (path: string) =>
      new Promise<number | string>((res) => {
        const req = http.get(`${a.url}${path}`, { agent }, (r) => {
          r.resume();
          r.on("end", () => res(r.statusCode ?? 0));
        });
        req.on("error", (e: NodeJS.ErrnoException) => res(e.code ?? e.message));
      });
    try {
      // connections to a, kept alive and idle
      expect(await Promise.all([0, 1, 2, 3].map((i) => get(`/increment?name=k${i}`)))).toEqual([
        200, 200, 200, 200,
      ]);
      // the client sends as the node starts to leave: a load balancer that has not yet seen it go
      const sent = [0, 1, 2, 3].map((i) => get(`/increment?name=k${i}`));
      const leaving = a.close();
      expect(await Promise.all(sent)).toEqual([200, 200, 200, 200]);
      await leaving;
    } finally {
      agent.destroy();
      await a.close();
      await b.close();
    }
  });

  it("a WebSocket on the public listener reaches the cell, on its owner or through it", async () => {
    const store = memoryObjectStore();
    const dir = join(examples, "wsecho");
    const a = await startFleetNode({ dir, store, node: "a", listen: "127.0.0.1:0" });
    const b = await startFleetNode({ dir, store, node: "b", listen: "127.0.0.1:0" });
    const talk = (base: string, msg: string) =>
      new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(`${base.replace("http", "ws")}/`);
        ws.on("open", () => ws.send(msg));
        ws.on("message", (d) => {
          resolve(JSON.parse(String(d)));
          ws.close();
        });
        ws.on("error", reject);
      });
    try {
      expect(await talk(a.url, "one")).toEqual({ echo: "one", count: 1 });
      expect(await talk(b.url, "two")).toEqual({ echo: "two", count: 2 });
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it("a node closes promptly while a peer's tunnel into it is still open", async () => {
    const store = memoryObjectStore();
    const dir = join(examples, "wsecho");
    const a = await startFleetNode({ dir, store, node: "a", listen: "127.0.0.1:0" });
    const b = await startFleetNode({ dir, store, node: "b", listen: "127.0.0.1:0" });
    try {
      // a owns the cell; a WebSocket opened at b crosses a tunnel into a and stays open
      const first = new WebSocket(`${a.url.replace("http", "ws")}/`);
      await new Promise((r, j) => (first.on("open", r), first.on("error", j)));
      first.close();
      const ws = new WebSocket(`${b.url.replace("http", "ws")}/`);
      await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
      const t = Date.now();
      const closed = await Promise.race([
        a.close().then(() => true),
        new Promise((r) => setTimeout(() => r(false), 8_000)),
      ]);
      expect(closed).toBe(true);
      expect(Date.now() - t).toBeLessThan(5_000);
      ws.terminate();
    } finally {
      await b.close();
    }
  }, 60_000);

  // AsyncLocalStorage on Node 22's async_hooks costs every promise: a node served 2.7 times
  // fewer requests (bench/cluster-bench.mjs). Node 24 runs it on AsyncContextFrame by default;
  // `cellb serve` asks Node 22 for the same, unless the user decided otherwise.
  it("serve runs AsyncLocalStorage on AsyncContextFrame where Node does not by default", () => {
    const FLAG = "--experimental-async-context-frame";
    expect(asyncContextFrameArgs("v22.23.5", [], undefined)).toEqual([FLAG]);
    expect(asyncContextFrameArgs("v22.23.5", [FLAG], undefined)).toEqual([]);
    expect(asyncContextFrameArgs("v22.23.5", [], `--max-old-space-size=4096 ${FLAG}`)).toEqual([]);
    expect(
      asyncContextFrameArgs("v22.23.5", ["--no-experimental-async-context-frame"], undefined),
    ).toEqual([]);
    expect(asyncContextFrameArgs("v24.1.0", [], undefined)).toEqual([]);
  });
});

// Reviewer finding (gate pass 1, #211): on Node 22 `cellb serve` relaunches itself, and a signal
// sent to the process group (Ctrl-C, systemd's KillMode=control-group) reaches the child twice:
// from the group, and forwarded by the parent. The child's handler was `once`, so the second
// copy found none and killed the node before it had released its cells.
/** A container engine that runs nothing: it records the containers started and the commands run. */
function recordingEngine() {
  const starts: ContainerSpec[] = [];
  const execs: string[][] = [];
  const engine: ContainerEngine = {
    running: 0,
    async start(spec) {
      starts.push(spec);
      let running = true;
      return {
        get running() {
          return running;
        },
        monitor: () => new Promise(() => {}),
        waitForPort: async () => {},
        fetch: async () => new Response("no server"),
        connect: () => {
          throw new Error("no socket");
        },
        exec: async (argv) => {
          execs.push(argv);
          const file = spec.files?.[argv[1].replace("/workspace/", "")];
          return {
            exitCode: 0,
            stdout: `${file ? "script found" : "no script"} ${argv[2]}`,
            stderr: "",
          };
        },
        signal: async () => {},
        destroy: async () => {
          running = false;
        },
      };
    },
    async close() {},
  };
  return { engine, starts, execs };
}

// Containers on fleet nodes: a node given a container engine runs the project's `containers`
// classes. A cell's container lives on the node that owns the cell; when the cell moves, the next
// owner starts the same image (cellb.containers.<class> of the project) and runs the same scripts.
describe("P50 containers on fleet nodes", () => {
  const dir = join(__dirname, "fixtures/container-runner");

  it("parses --containers, the module that makes the engine", () => {
    expect(
      parseServeArgs(["proj", "--bucket", "s3://cells", "--containers", "./engine.mjs"], {}),
    ).toMatchObject({ containers: "./engine.mjs" });
  });

  it("loads the engine from the module: its default export makes it", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "engine-"));
    writeFileSync(
      join(d, "engine.mjs"),
      "export default async () => ({ running: 0, start: async () => ({}), close: async () => {}, made: 'here' });",
    );
    writeFileSync(join(d, "object.mjs"), "export default { running: 0, start() {}, close() {} };");
    writeFileSync(join(d, "none.mjs"), "export default 42;");
    expect(await loadContainerEngine("./engine.mjs", d)).toMatchObject({ made: "here" });
    expect(await loadContainerEngine(join(d, "object.mjs"))).toMatchObject({ running: 0 });
    await expect(loadContainerEngine("./none.mjs", d)).rejects.toThrow(/container engine/);
  });

  it("runs a cell's container scripts on its owner, and on the next owner once it moves", async () => {
    const store = memoryObjectStore();
    const ea = recordingEngine();
    const eb = recordingEngine();
    const a = await startFleetNode({
      dir,
      store,
      node: "a",
      listen: "127.0.0.1:0",
      containers: ea.engine,
    });
    const b = await startFleetNode({
      dir,
      store,
      node: "b",
      listen: "127.0.0.1:0",
      containers: eb.engine,
    });
    try {
      expect(a.unsupported).toEqual([]);
      // first claimed through a: a owns it, a's engine runs the script, twice
      expect(await json(await fetch(`${a.url}/?cell=job`))).toEqual({
        runs: 1,
        exitCode: 0,
        out: "script found 1",
      });
      expect(await json(await fetch(`${b.url}/?cell=job`))).toEqual({
        runs: 2,
        exitCode: 0,
        out: "script found 2",
      });
      expect(ea.starts).toHaveLength(1);
      expect(eb.starts).toHaveLength(0);
      await a.close(); // a leaves: the cell is released, b takes it on the next request
      expect(await json(await fetch(`${b.url}/?cell=job`))).toEqual({
        runs: 3,
        exitCode: 0,
        out: "script found 3",
      });
      expect(eb.starts).toHaveLength(1);
      expect(eb.starts[0].files).toEqual(ea.starts[0].files);
      expect(eb.starts[0].entrypoint).toEqual(ea.starts[0].entrypoint);
      expect(eb.execs).toEqual([["bash", "/workspace/job.sh", "3"]]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("P50 stopping on signals", () => {
  it("a second SIGINT during the graceful stop does not kill the process", async () => {
    const { spawn } = await import("node:child_process");
    const p = spawn(
      process.execPath,
      ["--no-warnings", join(__dirname, "fixtures/stop-signals.mjs")],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    for (let i = 0; i < 100 && !out.includes("ready"); i++)
      await new Promise((r) => setTimeout(r, 50));
    p.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 30));
    p.kill("SIGINT");
    const [code, signal] = await new Promise<[number | null, string | null]>((r) =>
      p.once("exit", (c, s) => r([c, s])),
    );
    expect({ code, signal, out: out.trim().split("\n").at(-1) }).toEqual({
      code: 0,
      signal: null,
      out: "stopped 1",
    });
  }, 30_000);
});
