// The studio Worker on cellb in Node, against the scripted model (examples/fake-openai):
// a Flue agent edits a file through its capability, a read-only one is refused, a scoped one
// sees only its branch, and the Workspace's journal reports the agent's change with contents.
//   tsx test/studio-node.ts
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import {
  lastUserText,
  startFakeOpenAi,
  toolResults,
} from "../../../examples/fake-openai/src/index.ts";

const dir = fileURLToPath(new URL("../studio/", import.meta.url));
const ADMIN = { authorization: "Bearer sandbox-page", "content-type": "application/json" };

const fake = await startFakeOpenAi({
  reply: (req) => {
    const results = toolResults(req);
    const prompt = lastUserText(req);
    if (prompt.startsWith("EDIT") && results.length === 0)
      return {
        tool: "edit",
        args: { path: "/server/index.ts", oldText: "hello", newText: "hello from flue" },
      };
    if (prompt.startsWith("READ") && results.length === 0)
      return { tool: "read", args: { path: prompt.slice(5).trim() } };
    if (prompt.startsWith("WRITE") && results.length === 0)
      return { tool: "write", args: { path: "/server/new.ts", content: "export {};\n" } };
    if (prompt.startsWith("BASH") && results.length === 0)
      return { tool: "bash", args: { command: "ls /" } };
    return { text: `done: ${results.join(" | ").slice(0, 300)}` };
  },
});

const project = await loadProject(dir);
const call = async (path: string, body?: unknown, headers: Record<string, string> = ADMIN) => {
  const res = await project.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const data = (await res.json()) as { value?: any; error?: string };
  return { status: res.status, ...data };
};
try {
  const sync = await call("/api/w/demo/sync", {
    files: {
      "/server/index.ts": 'export default { fetch: () => new Response("hello") };\n',
      "/client/index.html": "<h1>x</h1>",
      "/secret.txt": "s3cret",
    },
    prune: true,
  });
  assert.equal(sync.status, 200, JSON.stringify(sync));
  assert.equal(sync.value.written, 3);

  const session = async (mode: string) =>
    (await call("/api/w/demo/sessions", { user: "me", rights: ["/"], mode, model: true }))
      .value as {
      session: string;
      token: string;
    };
  const llm = { baseUrl: fake.baseUrl, model: "fake", api: "openai-completions" };
  const run = (token: string, prompt: string, narrow?: unknown) =>
    call(
      "/api/agents/a1/run",
      { workspace: "demo", token, narrow, task: { prompt, llm, runId: crypto.randomUUID() } },
      { "content-type": "application/json", "x-llm-token": "fake-key-123" },
    );

  const yolo = await session("yolo");
  const edited = await run(yolo.token, "EDIT the greeting");
  assert.equal(edited.status, 200, JSON.stringify(edited));
  const changes = await call("/api/w/demo/changes?since=0");
  const change = changes.value.changes.find((c: any) => c.path === "/server/index.ts");
  assert.ok(change?.text?.includes("hello from flue"), JSON.stringify(changes));
  console.log("• a Flue agent edits a file; the journal reports it with its content");

  const ro = await session("readonly");
  const refused = await run(ro.token, "WRITE something");
  const lastWrite = toolResults(fake.requests.at(-1)!).at(-1) ?? "";
  assert.match(lastWrite, /EACCES|denied/i, lastWrite);
  const after = await call(`/api/w/demo/changes?since=${changes.value.cursor}`);
  assert.equal(after.value.changes.length, 0, JSON.stringify(after.value));
  console.log("• a read-only capability: the write is refused, nothing changes", refused.status);

  const scoped = await run(yolo.token, "READ /secret.txt", { scope: "/server" });
  const readResult = toolResults(fake.requests.at(-1)!).at(-1) ?? "";
  assert.doesNotMatch(readResult, /s3cret/);
  assert.match(readResult, /EACCES|denied|not/i, readResult);
  const ls = await run(yolo.token, "BASH ls", { scope: "/server" });
  const lsOut = toolResults(fake.requests.at(-1)!).at(-1) ?? "";
  assert.match(lsOut, /server/);
  assert.doesNotMatch(lsOut, /secret|client/);
  console.log(
    "• a capability scoped to /server: /secret.txt is unreadable, ls / shows only server",
    ls.status,
  );
  assert.ok(fake.authorizations.every((a) => a === "Bearer fake-key-123"));
  console.log("studio-node: all good");
} finally {
  await project.close();
  await fake.close();
}
process.exit(0);
