import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  celldBucket,
  createCellRuntime,
  createWebSocketClass,
  DurableObject,
  type DurableObjectNamespace,
  memoryObjectStore,
  runInDurableObject,
} from "../src/index.js";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";
import { CellsRequest, withUpgrade } from "../src/ws/upgrade.js";
import {
  AGENTS_WEBSOCKET_CONFIG,
  AGENTS_WEBSOCKET_WORKER,
  EXPECTED_GLOBALS,
} from "./agents-websocket-worker.js";
import {
  ASYNC_CONTEXT_CONFIG,
  ASYNC_CONTEXT_WORKER,
  expectedSeen,
} from "./async-context-worker.js";
import {
  EXPECTED_LOADED_SCOPE,
  LOADED_SCOPE_CONFIG,
  LOADED_SCOPE_WORKER,
} from "./loaded-scope-worker.js";

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

  // loadNodeProject runs loaded Workers in threads; without `isolatedModules`, in its realm.
  it.each([
    ["in its own thread", {}],
    ["in the project's realm", { isolatedModules: undefined }],
  ])("gives a loaded Worker its own env and exports, %s", async (_, where) => {
    const dir = mkdtempSync(join(tmpdir(), "p13-loaded-"));
    writeFileSync(join(dir, "index.js"), LOADED_SCOPE_WORKER);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(LOADED_SCOPE_CONFIG));
    const p = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
      ...where,
    });
    try {
      const res = await p.runtime.fetch(new Request("http://w/"));
      expect(await res.json()).toEqual(EXPECTED_LOADED_SCOPE);
    } finally {
      await p.runtime.close();
    }
  });

  it("reports the Workers AI binding as unsupported without an endpoint", async () => {
    const p = await project("ai", { ai: { binding: "AI" } });
    expect(p.unsupported).toEqual(["ai[AI] (Workers AI: give the host an OpenAI-compatible `ai`)"]);
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

describe("P13 AsyncLocalStorage under concurrent objects (Node: the reference)", () => {
  it("each object keeps its own store across every kind of continuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p13-als-"));
    writeFileSync(join(dir, "index.js"), ASYNC_CONTEXT_WORKER);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(ASYNC_CONTEXT_CONFIG));
    const p = await loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
    const r = await (await p.runtime.fetch(new Request("http://w/"))).json();
    expect(r.outside).toBeNull();
    for (const [name, seen] of Object.entries(r.results)) expect(seen).toEqual(expectedSeen(name));
    await p.runtime.close();
  });
});

describe("P13 the global WebSocket, as the Agents SDK uses it", () => {
  const start = async () => {
    const dir = mkdtempSync(join(tmpdir(), "p13-ws-"));
    writeFileSync(join(dir, "index.js"), AGENTS_WEBSOCKET_WORKER);
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(AGENTS_WEBSOCKET_CONFIG));
    return loadNodeProject(dir, { openSql: nodeSqliteOpener(), files: new MemFilesApi() });
  };

  it("is workerd's: attachments through its prototype, READY_STATE_* statics, one class", async () => {
    const p = await start();
    const res = await p.runtime.fetch(new Request("http://w/globals"));
    expect(await res.json()).toEqual(EXPECTED_GLOBALS);
    await p.runtime.close();
  });

  it("carries a chat: each socket's attachment names its sender, broadcasts reach open sockets", async () => {
    const p = await start();
    const WS = createWebSocketClass((url, protocols) => p.runtime.connectWebSocket(url, protocols));
    const join_ = async (user: string) => {
      const ws = new WS(`ws://w/room?user=${user}`);
      const inbox: string[] = [];
      ws.onmessage = (e: MessageEvent) => inbox.push(String(e.data));
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      return { ws, inbox };
    };
    const ann = await join_("ann");
    const bob = await join_("bob");
    ann.ws.send("hi");
    bob.ws.send("hello");
    for (let i = 0; i < 100 && (ann.inbox.length < 2 || bob.inbox.length < 2); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(ann.inbox.sort()).toEqual(["ann: hi", "bob: hello"]);
    expect(bob.inbox.sort()).toEqual(["ann: hi", "bob: hello"]);
    ann.ws.close();
    bob.ws.close();
    await p.runtime.close();
  });
});

describe("P13 the global Request keeps an upgrade's headers when copied", () => {
  // A browser drops `Upgrade` and `Sec-WebSocket-*` from every `new Request()`; the runtime carries
  // them as an own `headers` property (withUpgrade). partyserver copies the request with
  // `new Request(req)` before it forwards a socket: the copy must still be an upgrade.
  const upgrade = () =>
    withUpgrade(new Request("http://w/agents/chat/a"), "websocket", {
      "Sec-WebSocket-Protocol": "v1",
    });

  it("carries them through new Request(req), and through init headers", () => {
    const copy = new CellsRequest(upgrade());
    expect(copy.headers.get("Upgrade")).toBe("websocket");
    expect(copy.headers.get("Sec-WebSocket-Protocol")).toBe("v1");
    copy.headers.set("x-partykit-namespace", "chat"); // set after the copy, read by the runtime
    expect(copy.headers.get("x-partykit-namespace")).toBe("chat");
    const fromInit = new CellsRequest("http://w/", { headers: upgrade().headers });
    expect(fromInit.headers.get("Upgrade")).toBe("websocket");
    expect(new CellsRequest(upgrade()).clone().headers.get("Upgrade")).toBe("websocket");
    // `init.headers` replaces the input's, as in Request itself.
    expect(new CellsRequest(upgrade(), { headers: {} }).headers.get("Upgrade")).toBeNull();
  });

  it("counts the host's requests as instances", () => {
    expect(new Request("http://w/") instanceof CellsRequest).toBe(true);
    expect(new CellsRequest("http://w/") instanceof Request).toBe(true);
  });
});
