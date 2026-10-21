import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime } from "../src/index.js";
import { filesApiBlobService } from "../src/miniflare-compat/blob-service.js";
import { kvNamespaceBinding } from "../src/miniflare-compat/kv-binding.js";
// @ts-expect-error — generated JS bundle (scripts/vendor-miniflare.mjs), no .d.ts
import { KVNamespaceObject } from "../vendor/miniflare/kv-namespace.js";

// Hypothesis: Miniflare 4's KV simulator — a Durable Object written for workerd, on
// ctx.storage.sql + a blob service — runs UNCHANGED inside webrun-cells, so the KV
// binding needs no reimplementation: only a TS client for the wire protocol, a blob
// service on a FilesApi, and a few workerd shims.
function setup(files = new MemFilesApi()) {
  const rt = createCellRuntime({
    worker: {
      KVNamespaceObject,
      default: {
        async fetch(req: Request, env: any) {
          const kv = kvNamespaceBinding(env.KV_OBJECTS, "my-namespace");
          const key = new URL(req.url).pathname.slice(1);
          if (req.method === "PUT") {
            await kv.put(key, await req.text(), { metadata: { from: "worker" } });
            return new Response("stored");
          }
          return Response.json(await kv.getWithMetadata(key));
        },
      },
    },
    durableObjects: { KV_OBJECTS: { className: "KVNamespaceObject" } },
    vars: { MINIFLARE_BLOBS: filesApiBlobService(files) },
    openSql: nodeSqliteOpener(),
  });
  return { rt, files, kv: kvNamespaceBinding(rt.env.KV_OBJECTS as any, "my-namespace") };
}

describe("P08a Miniflare 4 KV simulator (unchanged) inside webrun-cells", () => {
  it("put / get (text, json, arrayBuffer) / delete", async () => {
    const { kv } = setup();
    await kv.put("a", "alpha");
    await kv.put("j", JSON.stringify({ x: 1 }));
    await kv.put("b", new Uint8Array([1, 2, 3]));
    expect(await kv.get("a")).toBe("alpha");
    expect(await kv.get("j", "json")).toEqual({ x: 1 });
    expect([...new Uint8Array((await kv.get("b", "arrayBuffer")) as ArrayBuffer)]).toEqual([
      1, 2, 3,
    ]);
    expect(await kv.get("missing")).toBeNull();
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  it("metadata, keys needing URL encoding, unicode values", async () => {
    const { kv } = setup();
    await kv.put("dir/with spaces?&#", "ünïcødé ✓", { metadata: { tag: "t1", n: 2 } });
    expect(await kv.getWithMetadata("dir/with spaces?&#")).toEqual({
      value: "ünïcødé ✓",
      metadata: { tag: "t1", n: 2 },
    });
  });

  it("list with prefix, limit and cursor (pagination)", async () => {
    const { kv } = setup();
    for (const k of ["a1", "a2", "a3", "b1"]) await kv.put(k, k, { metadata: { k } });
    const page1 = await kv.list({ prefix: "a", limit: 2 });
    expect(page1.keys.map((k) => k.name)).toEqual(["a1", "a2"]);
    expect(page1.list_complete).toBe(false);
    const page2 = await kv.list({ prefix: "a", limit: 2, cursor: page1.cursor });
    expect(page2.keys.map((k) => k.name)).toEqual(["a3"]);
    expect(page2.list_complete).toBe(true);
    expect(page1.keys[0].metadata).toEqual({ k: "a1" });
  });

  it("validation comes from Miniflare itself (e.g. expirationTtl below 60 s is rejected)", async () => {
    const { kv } = setup();
    await expect(kv.put("k", "v", { expirationTtl: 10 })).rejects.toThrow(/KV 400.*expiration/i);
    await kv.put("k", "v", { expirationTtl: 120 });
    const listed = await kv.list({ prefix: "k" });
    expect(listed.keys[0].expiration).toBeGreaterThan(Date.now() / 1000);
  });

  it("values live in the FilesApi blob store; keys and metadata in the object's SQLite", async () => {
    const { kv, files } = setup();
    await kv.put("big", "x".repeat(10_000));
    const blobs: string[] = [];
    for await (const f of files.list("/blobs", { recursive: true }))
      if (f.kind === "file") blobs.push(f.path);
    expect(blobs.length).toBeGreaterThan(0);
    expect(((await kv.get("big")) as string).length).toBe(10_000);
  });

  it("a Worker uses the binding through env, like on Cloudflare", async () => {
    const { rt } = setup();
    await rt.fetch(new Request("http://w/greeting", { method: "PUT", body: "hello" }));
    expect(await (await rt.fetch(new Request("http://w/greeting"))).json()).toEqual({
      value: "hello",
      metadata: { from: "worker" },
    });
  });
});
