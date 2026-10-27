import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadNodeProject, nodeSqliteOpener } from "../src/node.js";

// Workers AI (`env.AI`) served by an OpenAI-compatible endpoint: a fake one here, which echoes
// what it was asked and records every request.
type Recorded = { path: string; body: Record<string, any> };

async function fakeOpenAi() {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ path: req.url ?? "", body });
      if (req.headers.authorization !== "Bearer k") return res.writeHead(401).end("no key");
      if (req.url === "/v1/embeddings") {
        const inputs: string[] = [body.input].flat();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ data: inputs.map((t) => ({ embedding: [t.length, 1, 0] })) }),
        );
      }
      const last = body.messages.at(-1).content;
      if (body.tools?.length && last === "weather?") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c1", function: { name: "weather", arguments: '{"city":"Paris"}' } },
                  ],
                },
              },
            ],
          }),
        );
      }
      const text = `${body.model} heard ${last}`;
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: text } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of text.split(" "))
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${part} ` } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const worker = `
import { env } from "cloudflare:workers";
const atLoad = typeof env.AI?.run; // Flue's entry reads env.AI while the module is evaluated
export default {
  async fetch(req, env) {
    const ai = env.AI;
    const read = async (stream) => {
      const text = await new Response(stream).text();
      return text.split("\\n\\n").filter(Boolean);
    };
    const raw = await ai.run("@cf/meta/llama-3.1-8b-instruct",
      { messages: [{ role: "user", content: "raw" }], stream: true }, { returnRawResponse: true });
    let refused;
    try { await ai.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { image: [] }); }
    catch (e) { refused = e.name; }
    return Response.json({
      atLoad,
      prompt: await ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "hi" }),
      messages: await ai.run("@cf/other/model", { messages: [{ role: "user", content: "yo" }] }),
      tools: await ai.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: "weather?" }],
        tools: [{ name: "weather", description: "Weather", parameters: { type: "object" } }],
      }),
      stream: await read(await ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "go", stream: true })),
      raw: { status: raw.status, type: raw.headers.get("content-type"), lines: await read(raw.body) },
      embed: await ai.run("@cf/baai/bge-small-en-v1.5", { text: ["ab", "abcd"] }),
      refused,
    });
  },
};
`;

describe("P14 Workers AI over an OpenAI-compatible endpoint", () => {
  let llm: Awaited<ReturnType<typeof fakeOpenAi>>;
  beforeAll(async () => {
    llm = await fakeOpenAi();
  });
  afterAll(() => llm.close());

  it("answers text generation, tools, streams, raw responses and embeddings as Workers AI does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-"));
    writeFileSync(join(dir, "index.js"), worker);
    writeFileSync(
      join(dir, "wrangler.json"),
      JSON.stringify({ name: "p14", main: "index.js", ai: { binding: "AI" } }),
    );
    const p = await loadNodeProject(dir, {
      openSql: nodeSqliteOpener(),
      files: new MemFilesApi(),
      ai: {
        baseUrl: llm.baseUrl,
        apiKey: "k",
        models: { "@cf/meta/llama-3.1-8b-instruct": "llama", "*": "fallback" },
      },
    });
    try {
      expect(p.unsupported).toEqual([]);
      const r = await (await p.runtime.fetch(new Request("http://w/"))).json();
      expect(r.atLoad).toBe("function");
      expect(r.prompt).toEqual({
        response: "llama heard hi",
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
      expect(r.messages.response).toBe("fallback heard yo"); // "*" maps every other id
      expect(r.tools).toEqual({
        response: "",
        tool_calls: [{ name: "weather", arguments: { city: "Paris" } }],
      });
      expect(r.stream).toEqual([
        'data: {"response":"llama "}',
        'data: {"response":"heard "}',
        'data: {"response":"go "}',
        "data: [DONE]",
      ]);
      // The endpoint's own response, as Flue's provider reads it.
      expect(r.raw.status).toBe(200);
      expect(r.raw.type).toBe("text/event-stream");
      expect(r.raw.lines.at(-1)).toBe("data: [DONE]");
      expect(r.embed).toEqual({
        shape: [2, 3],
        data: [
          [2, 1, 0],
          [4, 1, 0],
        ],
        pooling: "mean",
      });
      expect(r.refused).toBe("AiError");

      const tools = llm.requests.find((q) => q.body.tools)!;
      expect(tools.body.tools).toEqual([
        {
          type: "function",
          function: { name: "weather", description: "Weather", parameters: { type: "object" } },
        },
      ]);
      expect(llm.requests.find((q) => q.path === "/v1/embeddings")!.body).toEqual({
        model: "fallback",
        input: ["ab", "abcd"],
      });
    } finally {
      await p.runtime.close();
    }
  });
});
