import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  celldBucket,
  createCellRuntime,
  DurableObject,
  type DurableObjectNamespace,
  memoryObjectStore,
  runInDurableObject,
} from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// What the Cloudflare Agents SDK (and Flue, built on it) needs from a host beyond the
// Durable Object API itself; packages/flue-example runs a whole Flue app.

const worker = `
import { DurableObject, env, exports } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import path from "path";
const atLoad = env.GREETING; // read while the module is evaluated, as Flue's entry does
export class Box extends DurableObject { hi() { return "box " + env.GREETING; } }
export default {
  async fetch() {
    let email;
    try { new EmailMessage("a@x", "b@x", "raw"); email = "built"; } catch (e) { email = e.message; }
    return Response.json({
      atLoad,
      now: env.GREETING,
      viaEnv: await env.BOX.getByName("a").hi(),
      viaExports: await exports.Box.getByName("a").hi(),
      join: path.join("a", "b"),
      email,
    });
  },
};
`;

function project(greeting: string, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "p13-"));
  writeFileSync(join(dir, "index.js"), worker);
  writeFileSync(
    join(dir, "wrangler.json"),
    JSON.stringify({
      name: `p13-${greeting}`,
      main: "index.js",
      compatibility_flags: ["nodejs_compat"],
      vars: { GREETING: greeting },
      durable_objects: { bindings: [{ name: "BOX", class_name: "Box" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Box"] }],
      ...extra,
    }),
  );
  return loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
}

describe("P13 modules the Agents SDK imports", () => {
  it("gives each project its own env and exports from cloudflare:workers", async () => {
    const [one, two] = await Promise.all([project("one"), project("two")]);
    const read = async (p: typeof one) => (await p.runtime.fetch(new Request("http://w/"))).json();
    expect(await read(one)).toEqual({
      atLoad: "one",
      now: "one",
      viaEnv: "box one",
      viaExports: "box one",
      join: "a/b", // a bare Node.js built-in name under nodejs_compat
      email: "cloudflare:email is not supported by cellb",
    });
    expect(await read(two)).toMatchObject({ atLoad: "two", viaExports: "box two" });
    await Promise.all([one.runtime.close(), two.runtime.close()]);
  });

  it("reports the Workers AI binding as unsupported", async () => {
    const p = await project("ai", { ai: { binding: "AI" } });
    expect(p.unsupported).toEqual(["ai[AI] (Workers AI)"]);
    await p.runtime.close();
  });
});

class Runs extends DurableObject {
  add(id: string) {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, callback TEXT)");
    // The Agents SDK names its keep-alive callback `_cf_keepAliveHeartbeat`: a value, not a table.
    sql.exec("DELETE FROM runs WHERE callback = '_cf_keepAliveHeartbeat' -- _cf_KV");
    sql.exec("INSERT INTO runs (id, callback) VALUES (?, '_cf_x')", id);
  }
  async burst(n: number) {
    // Commit, then write again a few microtasks later (the Agents SDK's fiber bookkeeping does).
    for (let i = 0; i < n; i++) {
      this.add(`b${i}`);
      await null;
      await null;
    }
  }
  count() {
    return this.ctx.storage.sql.exec("SELECT count(*) AS n FROM runs").one().n;
  }
}

describe("P13 storage under the Agents SDK's write pattern", () => {
  it("allows internal names inside string literals and comments, not as tables", async () => {
    const runtime = createCellRuntime({
      worker: { Runs, default: {} },
      durableObjects: { RUNS: { className: "Runs" } },
      openSql: nodeSqliteOpener(),
    });
    const stub = (runtime.env.RUNS as DurableObjectNamespace).getByName("a") as any;
    await stub.add("1");
    expect(await stub.count()).toBe(1);
    await runInDurableObject(stub, async (_i, ctx) => {
      expect(() => ctx.storage.sql.exec("SELECT * FROM _cf_KV")).toThrow(/is prohibited/);
    });
    await runtime.close();
  });

  it("logs back-to-back commits of an in-memory database without a broken object", async () => {
    // node:sqlite in memory has no page hook: the fleet bucket's LTX log needs each commit's
    // image, and asks for it after an await, when the next event may have opened its
    // transaction (an image cannot be taken inside one).
    const runtime = createCellRuntime({
      worker: { Runs, default: {} },
      durableObjects: { RUNS: { className: "Runs" } },
      openSql: nodeSqliteOpener(),
      storage: celldBucket(memoryObjectStore(), { node: "p13" }),
    });
    const stub = (runtime.env.RUNS as DurableObjectNamespace).getByName("a") as any;
    await stub.burst(20);
    expect(await stub.count()).toBe(20);
    await runtime.close();
  });
});
