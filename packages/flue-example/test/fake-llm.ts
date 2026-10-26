import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One chat-completions request the fake model received. */
export interface FakeLlmRequest {
  model: string;
  stream: boolean;
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
}

/** A scripted turn: a text reply, or one tool call. */
export type FakeTurn = { text: string } | { tool: string; args?: Record<string, unknown> };

/**
 * A fake OpenAI-compatible endpoint (`POST /v1/chat/completions`, streamed or not).
 * `reply` picks each turn from the request; every request is recorded.
 * `holdNext()` keeps the next response open until the returned release is called.
 */
export async function startFakeLlm(reply: (req: FakeLlmRequest) => FakeTurn) {
  const requests: FakeLlmRequest[] = [];
  let hold: { released: Promise<void>; entered: () => void } | undefined;
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as FakeLlmRequest;
    requests.push(body);
    const h = hold;
    hold = undefined;
    if (h) {
      h.entered();
      await h.released;
    }
    const turn = reply(body);
    const id = `chatcmpl-${requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const message =
      "text" in turn
        ? { role: "assistant", content: turn.text }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: "function",
                function: { name: turn.tool, arguments: JSON.stringify(turn.args ?? {}) },
              },
            ],
          };
    const finish = "text" in turn ? "stop" : "tool_calls";
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (choice: unknown, extra: Record<string, unknown> = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [choice], ...extra })}\n\n`,
      );
    chunk({ index: 0, delta: message, finish_reason: null });
    chunk({ index: 0, delta: {}, finish_reason: finish }, { usage });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Holds the next response; resolves `entered` once the request arrived. */
    holdNext() {
      let release!: () => void;
      let entered!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const arrived = new Promise<void>((r) => (entered = r));
      hold = { released, entered };
      return { arrived, release };
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}
