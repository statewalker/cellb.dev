import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/sandbox/agent/events";
import { type Change, createFlueAgent, llmOf, type StudioReply } from "../src/sandbox/agent/flue";
import { createMcpHandler } from "../src/sandbox/agent/mcp";
import {
  callTool,
  createTools,
  globToRegExp,
  projectPath,
  type RunState,
  type StudioHost,
  type StudioLogLine,
} from "../src/sandbox/agent/tools";
import { decode, encode } from "../src/sandbox/project";

/** A host over a Map: what the page does, without the page. */
function memoryHost(initial: Record<string, string>) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([p, t]) => [p, encode(t)]),
  );
  const dirs = new Set<string>();
  const logs: StudioLogLine[] = [];
  let state: RunState = { kind: "empty" };
  let runs = 0;
  const host: StudioHost = {
    project: () => ({ name: "demo", files, dirs, onDisk: false }),
    async writeFile(path, bytes) {
      files.set(path, bytes);
    },
    async mkdir(path) {
      dirs.add(path);
    },
    async remove(path) {
      for (const p of [...files.keys()])
        if (p === path || p.startsWith(`${path}/`)) files.delete(p);
    },
    async move(from, to) {
      const b = files.get(from);
      if (!b) throw new Error("missing");
      files.delete(from);
      files.set(to, b);
    },
    async run() {
      runs++;
      logs.push({ id: logs.length + 1, at: 0, text: `run ${runs}`, level: "info" });
      state = { kind: "running", baseUrl: "http://x/app/", server: true, client: true };
      return state;
    },
    async stop() {
      state = { kind: "stopped" };
    },
    state: () => state,
    logs: () => logs,
    async fetchApp(path, init) {
      return new Response(
        JSON.stringify({ path, method: init.method ?? "GET", body: init.body ?? null }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  };
  return { host, files, logs };
}

describe("agent tools", () => {
  it("paths stay inside the project", () => {
    expect(projectPath("server/index.ts")).toBe("/server/index.ts");
    expect(projectPath("/a//b/./c")).toBe("/a/b/c");
    expect(() => projectPath("../etc/passwd")).toThrow();
    expect(() => projectPath("  ")).toThrow();
  });

  it("globs match like .gitignore", () => {
    expect(globToRegExp("*.ts").test("server/index.ts")).toBe(true);
    expect(globToRegExp("client/**/*.tsx").test("client/src/main.tsx")).toBe(true);
    expect(globToRegExp("client/**/*.tsx").test("client/main.tsx")).toBe(true);
    expect(globToRegExp("server/*").test("server/a/b.ts")).toBe(false);
  });

  it("list, read, edit, write, search, move, delete", async () => {
    const { host, files } = memoryHost({
      "/server/index.ts": "export default {\n  fetch() { return new Response('hi'); }\n};\n",
      "/client/index.html": "<h1>x</h1>",
    });
    const tools = createTools(host);
    const list = await callTool(tools, "list_files", { pattern: "**/*.ts" });
    expect(list).toMatchObject({ ok: true, result: { files: [{ path: "server/index.ts" }] } });

    const read = await callTool(tools, "read_file", {
      path: "server/index.ts",
      offset: 2,
      limit: 1,
    });
    expect(read).toMatchObject({
      ok: true,
      result: { lines: 4, content: "  fetch() { return new Response('hi'); }" },
    });

    expect(
      await callTool(tools, "edit_file", {
        path: "server/index.ts",
        old_text: "'hi'",
        new_text: "'hello'",
      }),
    ).toMatchObject({ ok: true });
    expect(decode(files.get("/server/index.ts") as Uint8Array)).toContain("'hello'");

    const missing = await callTool(tools, "edit_file", {
      path: "server/index.ts",
      old_text: "nope",
      new_text: "x",
    });
    expect(missing).toMatchObject({ ok: false });

    await callTool(tools, "write_file", {
      path: "server/db.ts",
      content: "export const a = 1;\nexport const b = 1;\n",
    });
    const dup = await callTool(tools, "edit_file", {
      path: "server/db.ts",
      old_text: "= 1",
      new_text: "= 2",
    });
    expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("2 times") });
    await callTool(tools, "edit_file", {
      path: "server/db.ts",
      old_text: "= 1",
      new_text: "= 2",
      replace_all: true,
    });
    expect(decode(files.get("/server/db.ts") as Uint8Array)).toBe(
      "export const a = 2;\nexport const b = 2;\n",
    );

    const found = await callTool(tools, "search", { query: "Response\\(" });
    expect(found).toMatchObject({
      ok: true,
      result: { matches: ["server/index.ts:2:   fetch() { return new Response('hello'); }"] },
    });

    await callTool(tools, "move_path", { from: "server/db.ts", to: "server/store.ts" });
    expect(files.has("/server/store.ts")).toBe(true);
    await callTool(tools, "delete_path", { path: "server/store.ts" });
    expect(files.has("/server/store.ts")).toBe(false);
  });

  it("run, logs and requests to the app", async () => {
    const { host } = memoryHost({ "/wrangler.jsonc": "{}" });
    const tools = createTools(host);
    const notRunning = await callTool(tools, "http_request", { path: "api/x" });
    expect(notRunning).toMatchObject({ ok: false, error: expect.stringContaining("run_app") });
    const run = await callTool(tools, "run_app");
    expect(run).toMatchObject({ ok: true, result: { state: { kind: "running" }, log: ["run 1"] } });
    const res = await callTool(tools, "http_request", {
      path: "/api/items",
      method: "post",
      body: "{}",
    });
    expect(res).toMatchObject({ ok: true, result: { status: 200 } });
    expect(JSON.parse((res as { result: { body: string } }).result.body)).toEqual({
      path: "api/items",
      method: "POST",
      body: "{}",
    });
    const logs = await callTool(tools, "read_logs", { since: 1 });
    expect(logs).toMatchObject({ ok: true, result: { lines: [], last: 1 } });
  });

  it("refuses to work without a project", async () => {
    const tools = createTools({ ...memoryHost({}).host, project: () => undefined });
    expect(await callTool(tools, "list_files")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no project"),
    });
    expect(await callTool(tools, "nope")).toMatchObject({ ok: false });
  });
});

describe("MCP endpoint", () => {
  const rpc = (handler: (r: Request) => Promise<Response>, body: unknown) =>
    handler(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("initializes, lists and calls tools", async () => {
    const { host } = memoryHost({ "/a.txt": "alpha" });
    const handler = createMcpHandler(createTools(host));
    const init = await (
      await rpc(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    ).json();
    expect(init.result.serverInfo.name).toBe("cellb-sandbox");
    expect(init.result.capabilities.tools).toBeDefined();

    const note = await rpc(handler, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);

    const list = await (await rpc(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("edit_file");

    const call = await (
      await rpc(handler, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "a.txt" } },
      })
    ).json();
    expect(call.result.structuredContent.content).toBe("alpha");

    const err = await (
      await rpc(handler, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_file", arguments: { path: "b.txt" } },
      })
    ).json();
    expect(err.result.isError).toBe(true);

    const batch = await (
      await rpc(handler, [
        { jsonrpc: "2.0", id: 5, method: "ping" },
        { jsonrpc: "2.0", id: 6, method: "nope" },
      ])
    ).json();
    expect(batch).toHaveLength(2);
    expect(batch[1].error.code).toBe(-32601);
  });

  it("a read-only server hides the tools that change things", async () => {
    const handler = createMcpHandler(createTools(memoryHost({}).host), { readOnly: true });
    const list = await (await rpc(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
  });
});

describe("Flue agent client (the page as the Workspace's admin)", () => {
  it("syncs, gets a token per mode, runs, follows progress and mirrors the journal", async () => {
    const calls: { path: string; method: string; body?: any; headers?: Record<string, string> }[] =
      [];
    const applied: Change[] = [];
    let runs = 0;
    const studio = async (
      path: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<StudioReply> => {
      calls.push({ path, method: init.method ?? "GET", body: init.body, headers: init.headers });
      if (path.endsWith("/sync"))
        return { status: 200, value: { written: 2, deleted: 0, cursor: 7 } };
      if (path.endsWith("/sessions"))
        return {
          status: 200,
          value: { session: "s", token: `tok-${(init.body as { mode: string }).mode}` },
        };
      if (path.includes("/changes?since=7"))
        return {
          status: 200,
          value: { cursor: 9, changes: [{ seq: 9, path: "/a.txt", kind: "write", text: "agent" }] },
        };
      if (path.includes("/changes")) return { status: 200, value: { cursor: 9, changes: [] } };
      if (path.includes("/runs/"))
        return {
          status: 200,
          value: {
            done: true,
            events: [{ n: 1, type: "tool_call", id: "t1", name: "edit", input: {} }],
          },
        };
      if (path.endsWith("/run")) {
        runs++;
        await new Promise((r) => setTimeout(r, 30));
        return { status: 200, value: { reply: "ok", stopReason: "stop", turns: 2 } };
      }
      return { status: 404, error: "not found" };
    };
    const agent = createFlueAgent({
      studio,
      adminKey: "k",
      workspace: () => "demo",
      files: () =>
        new Map([
          ["/a.txt", encode("mine")],
          ["/b.bin", new Uint8Array([0, 1, 2])],
        ]),
      apply: async (c) => {
        applied.push(...c);
      },
      pollMs: 5,
    });
    const events: AgentEvent[] = [];
    const model = { provider: "openai" as const, model: "m", apiKey: "", baseUrl: "http://m/v1/" };
    const r = await agent.send("do it", {
      mode: "readonly",
      scope: "/client/",
      model,
      onEvent: (e) => events.push(e),
    });
    expect(r).toMatchObject({ reply: "ok", turns: 2 });
    const sync = calls.find((c) => c.path === "/api/w/demo/sync");
    expect(sync?.headers?.authorization).toBe("Bearer k");
    expect(sync?.body.files).toEqual({ "/a.txt": "mine", "/b.bin": { $b64: "AAEC" } });
    expect(sync?.body.prune).toBe(true);
    const run = calls.find((c) => c.path === "/api/agents/agent-demo/run");
    expect(run?.body).toMatchObject({
      workspace: "demo",
      token: "tok-readonly",
      narrow: { scope: "/client" },
      task: {
        prompt: "do it",
        llm: { api: "openai-completions", baseUrl: "http://m/v1", model: "m" },
      },
    });
    expect(run?.headers?.["x-llm-token"]).toBeTruthy();
    expect(applied).toEqual([{ seq: 9, path: "/a.txt", kind: "write", text: "agent" }]);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    // A second run in the same mode reuses the token.
    await agent.send("again", { mode: "readonly", model, onEvent: () => {} });
    expect(calls.filter((c) => c.path.endsWith("/sessions"))).toHaveLength(1);
    expect(runs).toBe(2);
  });

  it("names Claude through pi-ai's Anthropic API", () => {
    expect(llmOf({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "x" })).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
    });
  });
});
