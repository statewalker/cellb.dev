import { describe, expect, it } from "vitest";
import { type AgentEvent, createAgentSession } from "../src/sandbox/agent/agent";
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

describe("agent loop (OpenAI-compatible endpoint)", () => {
  it("runs the tool calls the model makes, then ends with its answer", async () => {
    const { host, files } = memoryHost({ "/hello.txt": "hi" });
    const requests: { messages: { role: string; content: string | null }[] }[] = [];
    const replies = [
      {
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "hello.txt", content: "hello" }),
            },
          },
        ],
      },
      { content: "Done: hello.txt says hello." },
    ];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      const message = { role: "assistant", ...replies[requests.length - 1] };
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const session = createAgentSession({
      config: { provider: "openai", model: "m", apiKey: "", baseUrl: "http://model/v1" },
      tools: () => createTools(host),
      instructions: () => "Always greet.",
      fetch: fakeFetch,
    });
    const events: AgentEvent[] = [];
    await session.send("make hello.txt say hello", (e) => events.push(e));
    expect(decode(files.get("/hello.txt") as Uint8Array)).toBe("hello");
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(requests[0].messages[0].content).toContain("Always greet.");
    // The tool's result went back to the model.
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "tool" });
  });
});
