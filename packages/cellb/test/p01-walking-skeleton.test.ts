import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeSqliteOpener } from "../src/adapters/node-sqlite.js";
import { createCellRuntime } from "../src/index.js";
import { worker } from "./fixtures.js";

const newRuntime = (dir?: string) =>
  createCellRuntime({
    worker,
    durableObjects: { COUNTER: { className: "Counter" } },
    openSql: nodeSqliteOpener(dir),
  });

describe("P01 walking skeleton: Request → Worker → DO stub → SQLite → Response", () => {
  it("routes a request through the worker into a named object and its SQL storage", async () => {
    const rt = newRuntime();
    const post = (p: string) => rt.fetch(new Request(`http://cells.local${p}`, { method: "POST" }));
    expect(await (await post("/counter/a/inc")).json()).toEqual({ n: 1 });
    expect(await (await post("/counter/a/inc")).json()).toEqual({ n: 2 });
    const got = await (await rt.fetch(new Request("http://cells.local/counter/a"))).json();
    expect(got).toMatchObject({ n: 2, name: "a" });
    expect(got.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("isolates objects by name (one SQLite per cell)", async () => {
    const rt = newRuntime();
    await rt.fetch(new Request("http://x/counter/a/inc", { method: "POST" }));
    const b = await (await rt.fetch(new Request("http://x/counter/b"))).json();
    expect(b.n).toBe(0);
  });

  it("supports JS RPC on stubs with structured-clone boundaries", async () => {
    const rt = newRuntime();
    expect(await (await rt.fetch(new Request("http://x/counter/r/rpc/5"))).json()).toEqual({
      n: 5,
    });
    const ns: any = rt.env.COUNTER;
    expect(await ns.getByName("r").value()).toBe(5);
    await expect(ns.getByName("r").nope()).rejects.toThrow(/does not implement/);
    // stubs must not look like thenables
    expect(typeof ns.getByName("r").then).toBe("undefined");
  });

  it("RPC arguments and results are copied (no shared references across the stub)", async () => {
    const { probeRuntime } = await import("./helpers.js");
    const stub = probeRuntime().ns.getByName("clone");
    const arg = [1];
    const res = await stub.keep(arg);
    expect(arg).toEqual([1]);
    res.push(7);
    expect(await stub.kept()).toEqual([1, 99]);
  });

  it("idFromName is deterministic and namespaced; idFromString round-trips", () => {
    const ns: any = newRuntime().env.COUNTER;
    const a1 = ns.idFromName("a");
    expect(a1.toString()).toBe(ns.idFromName("a").toString());
    expect(a1.toString()).not.toBe(ns.idFromName("b").toString());
    expect(ns.idFromString(a1.toString()).equals(a1)).toBe(true);
    expect(ns.newUniqueId().toString()).not.toBe(ns.newUniqueId().toString());
  });

  it("state survives eviction when the SQL opener persists (file per cell)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cells-"));
    const rt1 = newRuntime(dir);
    await rt1.fetch(new Request("http://x/counter/p/rpc/7"));
    rt1.evictAll();
    const rt2 = newRuntime(dir);
    expect(await (rt2.env.COUNTER as any).getByName("p").value()).toBe(7);
  });

  it("turns handler exceptions into 500s at the worker boundary", async () => {
    const rt = createCellRuntime({
      worker: {
        default: {
          fetch() {
            throw new Error("boom");
          },
        },
      },
      openSql: nodeSqliteOpener(),
    });
    const r = await rt.fetch(new Request("http://x/"));
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/boom/);
  });
});
