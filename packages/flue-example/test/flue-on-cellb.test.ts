import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlueClient } from "@flue/sdk";
import {
  celldBucket,
  createWebSocketClass,
  memoryObjectStore,
  type ObjectStore,
} from "@statewalker/cellb";
import { loadNodeProject, nodeSqliteOpener } from "@statewalker/cellb/node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeLlm } from "./fake-llm.js";

// The app as Flue's own Cloudflare build emits it (`vite build`: flue() + @cloudflare/vite-plugin).
const built = join(import.meta.dirname, "../dist/flue_example");

/** A copy of the build whose `LLM_BASE_URL` var points at `baseUrl`. */
function deployment(baseUrl: string): string {
  if (!existsSync(join(built, "wrangler.json")))
    throw new Error("run `vite build` first (pnpm test does)");
  const dir = mkdtempSync(join(tmpdir(), "flue-on-cellb-"));
  cpSync(built, dir, { recursive: true });
  const config = JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8"));
  config.vars = { ...config.vars, LLM_BASE_URL: baseUrl };
  writeFileSync(join(dir, "wrangler.json"), JSON.stringify(config));
  return dir;
}

type Llm = Awaited<ReturnType<typeof startFakeLlm>>;

// First turn: call the tool; once the tool result is in the conversation, answer with it.
const scripted = (req: Parameters<Parameters<typeof startFakeLlm>[0]>[0]) => {
  const last = req.messages.at(-1);
  if (last?.role === "tool") return { text: `The answer is ${JSON.stringify(last.content)}.` };
  return { tool: "lookup_answer" };
};

describe("a Flue agent app on cellb", () => {
  let llm: Llm;
  beforeAll(async () => {
    llm = await startFakeLlm(scripted);
  });
  afterAll(() => llm.close());

  it("loads with nothing unsupported and answers a prompt through a tool call", async () => {
    const { runtime, unsupported } = await loadNodeProject(deployment(llm.baseUrl), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      expect(unsupported).toEqual([]);
      expect(Object.keys(runtime.durableObjectBindings)).toContain("FLUE_ASSISTANT_AGENT");

      const ping = await runtime.fetch(new Request("http://app.test/ping"));
      expect(await ping.text()).toBe("pong");

      const client = createFlueClient({
        url: "http://app.test/agents/assistant/conv-1",
        fetch: (input, init) => runtime.fetch(new Request(input, init)),
      });
      const admission = await client.send({
        message: { kind: "user", body: "What is the answer?" },
      });
      expect(admission.submissionId).toBeTruthy();
      const reply = await client.read(admission);
      expect(reply.text).toContain("42");

      // Two model turns: the tool call, then the answer built from the tool's result.
      expect(llm.requests.length).toBe(2);
      expect(llm.requests[0].tools?.map((t) => t.function.name)).toContain("lookup_answer");
      expect(llm.requests[1].messages.some((m) => m.role === "tool")).toBe(true);

      // The conversation is stored in the agent's Durable Object: history reads it back.
      const history = await client.history();
      const roles = history.messages.map((m) => m.role);
      expect(roles[0]).toBe("user");
      expect(roles.at(-1)).toBe("assistant");
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it("streams a reply live over SSE and runs two conversations at once", async () => {
    const { runtime } = await loadNodeProject(deployment(llm.baseUrl), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    try {
      const clientFor = (id: string) =>
        createFlueClient({
          url: `http://app.test/agents/assistant/${id}`,
          fetch: (input, init) => runtime.fetch(new Request(input, init)),
        });
      const a = clientFor("conv-a");
      const b = clientFor("conv-b");
      const [sa, sb] = await Promise.all([
        a.send({ message: { kind: "user", body: "a?" } }),
        b.send({ message: { kind: "user", body: "b?" } }),
      ]);
      // Observe conv-a live while its reply is being written: the SSE response stays open
      // through the agent's Durable Object and receives events as they are committed.
      const phases: string[] = [];
      const seen = await new Promise<string>((resolve, reject) => {
        const observation = a.observe({ live: "sse" });
        const timer = setTimeout(() => reject(new Error(`no live reply: ${phases}`)), 30_000);
        observation.subscribe(() => {
          const { conversation, phase, error } = observation.getSnapshot();
          phases.push(phase);
          if (phase === "error") reject(error);
          const settled = conversation?.settlements.some((x) => x.outcome === "completed");
          if (settled && JSON.stringify(conversation?.messages).includes("42")) {
            clearTimeout(timer);
            resolve(phase);
            observation.close();
          }
        });
      });
      expect(seen).toBe("live");
      const [ra, rb] = await Promise.all([a.read(sa), b.read(sb)]);
      expect(ra.text).toContain("42");
      expect(rb.text).toContain("42");
    } finally {
      await runtime.close();
    }
  }, 60_000);
});

// A conversation whose node stops in the middle of a model call continues on another node
// that shares the fleet bucket: the cell (its SQLite, with Flue's submission and fiber rows)
// moves, and Flue's recovery finishes the submission there.
describe("a Flue conversation moving between cellb nodes", () => {
  let llm: Llm;
  beforeAll(async () => {
    llm = await startFakeLlm(scripted);
  });
  afterAll(() => llm.close());

  const node = async (dir: string, store: ObjectStore, name: string) =>
    loadNodeProject(dir, {
      openSql: nodeSqliteOpener(), // in memory: node B has nothing local, only the bucket
      files: new MemFilesApi(),
      storage: celldBucket(store, { node: name, leaseTtlMs: 3_000 }),
    });

  it("finishes on node B a submission node A was running when it stopped", async () => {
    const dir = deployment(llm.baseUrl);
    const store = memoryObjectStore();
    const url = "http://app.test/agents/assistant/moving";
    const a = await node(dir, store, "node-a");
    const onA = createFlueClient({
      url,
      fetch: (i, init) => a.runtime.fetch(new Request(i, init)),
    });
    const held = llm.holdNext();
    const admission = await onA.send({ message: { kind: "user", body: "What is the answer?" } });
    await held.arrived; // node A is inside the first model call
    await a.runtime.close();
    const before = llm.requests.length;

    const b = await node(dir, store, "node-b");
    try {
      const onB = createFlueClient({
        url,
        fetch: async (i, init) => {
          // The cell is free once node A's ownership lapses; until then node B refuses it.
          for (let n = 0; ; n++) {
            const res = await b.runtime.fetch(new Request(i, init));
            if (res.status < 500 || n > 80) return res;
            await new Promise((r) => setTimeout(r, 250));
          }
        },
      });
      const reply = await onB.read(admission);
      expect(reply.text).toContain("42");
      // Node B ran the interrupted turn again (the tool call) and then the answer.
      expect(llm.requests.length - before).toBe(2);
      expect(llm.requests[before].messages.some((m) => m.role === "tool")).toBe(false);
      const history = await onB.history();
      expect(history.messages[0].role).toBe("user");
      expect(history.messages.filter((m) => m.role === "user")).toHaveLength(1);
    } finally {
      held.release();
      await b.runtime.close();
    }
  }, 90_000);
});

// The agent is an Agents SDK Agent: besides Flue's HTTP and SSE routes, clients can hold a
// WebSocket to it (partyserver connections, hibernatable) and share its state.
describe("WebSocket connections to a Flue agent on cellb", () => {
  let llm: Llm;
  beforeAll(async () => {
    llm = await startFakeLlm(scripted);
  });
  afterAll(() => llm.close());

  it("syncs the agent's state between two live connections, and keeps it", async () => {
    const { runtime } = await loadNodeProject(deployment(llm.baseUrl), {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
    });
    const WS = createWebSocketClass((url, protocols) => runtime.connectWebSocket(url, protocols));
    /** A connection and the parsed messages it received, awaited by type. */
    const connect = (name: string) => {
      const ws = new WS(`ws://app.test/agents/flue-assistant-agent/${name}`);
      const seen: { type: string; [k: string]: unknown }[] = [];
      const waiters: [string, (m: (typeof seen)[number]) => void][] = [];
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String((e as MessageEvent).data));
        seen.push(m);
        for (const w of waiters.splice(0)) {
          if (w[0] === m.type) w[1](m);
          else waiters.push(w);
        }
      });
      const next = (type: string) =>
        new Promise<(typeof seen)[number]>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no ${type}: ${JSON.stringify(seen)}`)),
            10_000,
          );
          waiters.push([type, (m) => (clearTimeout(timer), resolve(m))]);
        });
      return { ws, next };
    };
    try {
      const a = connect("room-1");
      const b = connect("room-1");
      // On connect, each socket is told which agent it reached (partyserver's onConnect ran).
      expect(await a.next("cf_agent_identity")).toMatchObject({
        name: "room-1",
        agent: "flue-assistant-agent",
      });
      await b.next("cf_agent_identity");

      // A state set by one client reaches the other (the agent's webSocketMessage handler
      // recognised the socket as one of its connections).
      const fromB = b.next("cf_agent_state");
      a.ws.send(JSON.stringify({ type: "cf_agent_state", state: { topic: "answers" } }));
      expect((await fromB).state).toEqual({ topic: "answers" });

      // The state is the agent's, stored in its SQLite: a later connection starts with it.
      const c = connect("room-1");
      expect((await c.next("cf_agent_state")).state).toEqual({ topic: "answers" });
      for (const x of [a, b, c]) x.ws.close();
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
