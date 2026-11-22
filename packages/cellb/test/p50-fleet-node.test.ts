import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { asyncContextFrameArgs } from "../src/cli.js";
import { memoryObjectStore } from "../src/index.js";
import { parseServeArgs, startFleetNode } from "../src/node.js";

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
