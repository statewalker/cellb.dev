// The studio Worker on cellb in Node, over different FilesApis the host provides (memory, a
// directory on disk, a composite of both), against the scripted model (examples/fake-openai):
//   - the token transport: an owner token's FilesApi writes and reads the backing store itself
//   - a Flue agent edits a file through its capability: the backing store has the change
//   - a read-only capability: the agent's write is refused, the store is unchanged
//   - a capability scoped to /server: /secret.txt is unreadable, ls / shows only server
//   - readTree: the tree as a token sees it (a read-only scoped token sees only its branch)
//   tsx test/studio-node.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";
import type { FilesApi } from "@statewalker/webrun-files";
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import {
  lastUserText,
  startFakeOpenAi,
  toolResults,
} from "../../../examples/fake-openai/src/index.ts";
import { attenuationBlock } from "../studio/src/capfs/policy.ts";
import { files, TokenCap } from "../studio/src/capfs/token-cap.ts";

const dir = fileURLToPath(new URL("../studio/", import.meta.url));
const ADMIN = { authorization: "Bearer sandbox-page", "content-type": "application/json" };
const text = (s: string) => new TextEncoder().encode(s);
async function readText(fs: FilesApi, path: string) {
  let out = "";
  for await (const c of fs.read(path)) out += new TextDecoder().decode(c, { stream: true });
  return out;
}

// The host seam, as the sandbox's studio worker sets it: a FilesApi per workspace.
const stores = new Map<string, FilesApi>();
const notified: string[] = [];
(globalThis as Record<string, unknown>).cellbStudioHost = {
  store: (ws: string) => stores.get(ws),
  notify: (ws: string, path: string, kind: string) => notified.push(`${ws}:${kind}:${path}`),
  call: async () => ({ ok: false, error: "no app in this test" }),
};

const fake = await startFakeOpenAi({
  reply: (req) => {
    const results = toolResults(req);
    const prompt = lastUserText(req);
    if (results.length) return { text: `done: ${results.join(" | ").slice(0, 300)}` };
    if (prompt.startsWith("EDIT"))
      return {
        tool: "edit",
        args: { path: "/server/index.ts", oldText: "hello", newText: "hello from flue" },
      };
    if (prompt.startsWith("READ")) return { tool: "read", args: { path: prompt.slice(5).trim() } };
    if (prompt.startsWith("WRITE"))
      return { tool: "write", args: { path: "/server/new.ts", content: "export {};\n" } };
    return { tool: "bash", args: { command: "ls /" } };
  },
});

const project = await loadProject(dir);
const send = (req: Request) => project.fetch(req);
const call = async (path: string, body?: unknown, headers: Record<string, string> = ADMIN) => {
  const res = await project.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: the API's values, checked by the asserts
  const data = (await res.json()) as { value?: any; error?: string };
  return { status: res.status, ...data };
};

async function scenario(label: string, ws: string, backing: FilesApi, onDisk?: string) {
  await backing.write("/server/index.ts", [
    text('export default { fetch: () => new Response("hello") };\n'),
  ]);
  await backing.write("/client/index.html", [text("<h1>x</h1>")]);
  await backing.write("/secret.txt", [text("s3cret")]);
  stores.set(ws, backing);
  const session = async (mode: string) =>
    (await call(`/api/w/${ws}/sessions`, { user: "me", rights: ["/"], mode, model: true }))
      .value as {
      token: string;
    };
  const llm = { baseUrl: fake.baseUrl, model: "fake", api: "openai-completions" };
  const run = (token: string, prompt: string, narrow?: unknown) =>
    call(
      "/api/agents/a1/run",
      { workspace: ws, token, narrow, task: { prompt, llm } },
      { "content-type": "application/json", "x-llm-token": "fake-key-123" },
    );
  const lastResult = () =>
    toolResults(fake.requests.at(-1) as (typeof fake.requests)[number]).at(-1) ?? "";

  // The token transport: a FilesApi on an owner token writes the backing store itself.
  const owner = await session("yolo");
  const ownerFs = files(new TokenCap(send, ws, owner.token));
  await ownerFs.write("/notes/a.md", [text("# A\n")]);
  assert.equal(await readText(backing, "/notes/a.md"), "# A\n");
  assert.equal(await readText(ownerFs, "/secret.txt"), "s3cret");
  if (onDisk) assert.equal(await readFile(join(onDisk, "notes/a.md"), "utf8"), "# A\n");
  assert.ok(notified.includes(`${ws}:write:/notes/a.md`));

  const edited = await run(owner.token, "EDIT the greeting");
  assert.equal(edited.status, 200, JSON.stringify(edited));
  assert.match(await readText(backing, "/server/index.ts"), /hello from flue/);

  const ro = await session("readonly");
  await run(ro.token, "WRITE something");
  assert.match(lastResult(), /EACCES|denied/i);
  assert.equal(await backing.exists("/server/new.ts"), false);
  await assert.rejects(
    files(new TokenCap(send, ws, ro.token)).write("/x.txt", [text("x")]),
    /EACCES/,
  );

  await run(owner.token, "READ /secret.txt", { scope: "/server" });
  assert.doesNotMatch(lastResult(), /s3cret/);
  await run(owner.token, "BASH ls", { scope: "/server" });
  assert.match(lastResult(), /server/);
  assert.doesNotMatch(lastResult(), /secret|client/);

  // A read-only token narrowed offline to /client (one more Biscuit block): what a build gets.
  const build = await new TokenCap(send, ws, ro.token).attenuate(
    attenuationBlock({ scope: "/client" }),
  );
  const tree = await (build as TokenCap).readTree("/", { contents: true, skip: ["node_modules"] });
  assert.deepEqual(
    tree.map((e) => e.path),
    ["/client/index.html"],
  );
  assert.equal(new TextDecoder().decode(tree[0]?.data), "<h1>x</h1>");
  console.log(`• ${label}: token FilesApi, Flue edit, read-only refusal, scope, readTree`);
}

try {
  await scenario("memory", "mem", new MemFilesApi());
  const disk = await mkdtemp(join(tmpdir(), "studio-node-"));
  await scenario(
    "a directory on disk (NodeFilesApi)",
    "disk",
    new NodeFilesApi({ rootDir: disk }),
    disk,
  );
  const disk2 = await mkdtemp(join(tmpdir(), "studio-node-"));
  const composite = new CompositeFilesApi(new MemFilesApi());
  composite.mount("/server", new NodeFilesApi({ rootDir: disk2 }));
  await scenario("composite (memory root, /server on disk)", "comp", composite);
  assert.match(await readFile(join(disk2, "index.ts"), "utf8"), /hello from flue/);
  assert.ok(fake.authorizations.every((a) => a === "Bearer fake-key-123"));
  console.log("studio-node: all good");
} finally {
  await project.close();
  await fake.close();
}
process.exit(0);
