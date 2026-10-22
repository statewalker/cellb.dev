import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import {
  cellsHttpHandler,
  connectRuntime,
  createCellRuntime,
  remoteRuntime,
  serveRuntime,
} from "../src/index.js";
import { worker } from "./fixtures.js";

const newRuntime = () =>
  createCellRuntime({
    worker,
    durableObjects: { COUNTER: { className: "Counter" } },
    openSql: nodeSqliteOpener(),
  });

describe("P04b cells behind a MessagePort (webrun-rpc + webrun-http-streams)", () => {
  const setup = async () => {
    const { port1, port2 } = new MessageChannel();
    const stop = await serveRuntime(port1 as any, newRuntime());
    const remote = await connectRuntime(port2 as any);
    return {
      remote,
      close: async () => (await remote.close(), await stop(), port1.close(), port2.close()),
    };
  };

  it("ingress: Request → port → worker fetch → DO → Response", async () => {
    const { remote, close } = await setup();
    const post = () =>
      remote.fetch(new Request("http://cells.local/counter/a/inc", { method: "POST" }));
    expect(await (await post()).json()).toEqual({ n: 1 });
    expect(await (await post()).json()).toEqual({ n: 2 });
    close();
  });

  it("bodies, status and headers survive the envelope", async () => {
    const { remote, close } = await setup();
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const r = await remote.fetch(
      new Request("http://x/echo", {
        method: "PUT",
        body: bytes,
        headers: { "x-test": "hi", "content-type": "application/octet-stream" },
      }),
    );
    expect(r.status).toBe(201);
    expect(r.headers.get("x-echo")).toBe("hi");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    close();
  });

  it("remote stubs: RPC and fetch, idFromName computed locally matches the host, ctx.id.name kept", async () => {
    const { remote, close } = await setup();
    const local = newRuntime();
    const ns = remote.env.COUNTER;
    expect(ns.idFromName("z").toString()).toBe(
      (local.env.COUNTER as any).idFromName("z").toString(),
    );
    expect(await ns.getByName("z").increment(4)).toBe(4);
    const viaFetch = await (await ns.getByName("z").fetch("http://x/")).json();
    expect(viaFetch).toMatchObject({ n: 4, name: "z" });
    const byId = ns.get(ns.idFromString(ns.idFromName("z").toString()));
    expect(await byId.value()).toBe(4);
    close();
  });

  it("streams response bodies chunk by chunk (SSE from a Durable Object)", async () => {
    const { remote, close } = await setup();
    const res = await remote.env.COUNTER.getByName("s").fetch("http://x/ticks");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const t0 = Date.now();
    const arrivals: number[] = [];
    let text = "";
    for await (const chunk of res.body as any) {
      arrivals.push(Date.now() - t0);
      text += new TextDecoder().decode(chunk);
    }
    expect(text).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");
    expect(arrivals.length).toBeGreaterThanOrEqual(3); // not buffered into one chunk
    expect(arrivals.at(-1)! - arrivals[0]).toBeGreaterThanOrEqual(40);
    await close();
  });

  it("the DO sees the original URL (scheme, host, query) and no control headers", async () => {
    const { remote, close } = await setup();
    const j = await (
      await remote.env.COUNTER.getByName("w").fetch("https://app.example:8443/a/whoami?q=1")
    ).json();
    expect(j).toEqual({ url: "https://app.example:8443/a/whoami?q=1", internal: [] });
    await close();
  });

  it("the same HTTP surface works with no transport at all (handler as `send`)", async () => {
    const rt = newRuntime();
    const remote = await remoteRuntime(cellsHttpHandler(rt));
    expect(await remote.env.COUNTER.getByName("h").increment(2)).toBe(2);
    expect(await (await remote.fetch(new Request("http://x/counter/h"))).json()).toMatchObject({
      n: 2,
    });
  });

  it("RPC values keep structured-clone types (Date, Map) across the link", async () => {
    const rt = createCellRuntime({
      worker: {
        default: {},
        Echo: class {
          echo(v: unknown) {
            return v;
          }
        },
      },
      durableObjects: { ECHO: { className: "Echo" } },
      openSql: nodeSqliteOpener(),
    });
    const remote = await remoteRuntime(cellsHttpHandler(rt));
    const v = { d: new Date(5), m: new Map([["k", 1n]]) };
    expect(await remote.env.ECHO.getByName("e").echo(v)).toEqual(v);
  });

  it("errors cross the port with their message", async () => {
    const { remote, close } = await setup();
    await expect(remote.env.COUNTER.getByName("e").nope()).rejects.toThrow(
      /nope is not a function/,
    ); // celld's wording
    close();
  });

  it("input gate still holds when calls arrive over the port", async () => {
    const { remote, close } = await setup();
    const stub = remote.env.COUNTER.getByName("c");
    const results = await Promise.all(Array.from({ length: 30 }, () => stub.increment(1)));
    expect(new Set(results).size).toBe(30);
    close();
  });
});

describe("P04b cells in a separate thread (stand-in for the browser Dedicated Worker)", () => {
  let bundle = "";
  const dir = mkdtempSync(join(tmpdir(), "cells-w-"));
  beforeAll(async () => {
    bundle = join(dir, "cell-worker.mjs");
    await build({
      entryPoints: [join(__dirname, "cell-worker.entry.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
      logLevel: "silent",
    });
  });
  const workers: Worker[] = [];
  afterAll(async () => {
    for (const w of workers) await w.terminate();
  });

  const spawn = async () => {
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(bundle, {
      workerData: { port: port2, dir },
      transferList: [port2 as any],
    });
    workers.push(w);
    await new Promise((r) => w.once("message", r));
    const remote = await connectRuntime(port1 as any);
    return { w, remote, port1 };
  };

  it("serves concurrent ingress from another thread, and state survives a worker restart", async () => {
    const a = await spawn();
    const res = await Promise.all(
      Array.from({ length: 20 }, () =>
        a.remote
          .fetch(new Request("http://x/counter/t/inc", { method: "POST" }))
          .then((r) => r.json()),
      ),
    );
    expect(res.map((r) => r.n).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    a.port1.close();
    await a.w.terminate(); // "tab closed" — no graceful shutdown

    const b = await spawn();
    expect(await b.remote.env.COUNTER.getByName("t").value()).toBe(20);
    b.port1.close();
  });
});
