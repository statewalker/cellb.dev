/**
 * A scripted OpenAI-compatible model endpoint, for running agents offline (pi, opencode, Flue,
 * the Workers AI binding): `POST /v1/chat/completions` (streamed or not, text or tool calls),
 * `POST /v1/embeddings`, `GET /v1/models`. CORS is open, so pages and workers on another origin
 * can call it too. Every request is recorded.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One chat-completions request the fake model received. */
export interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: { type?: string; function: { name: string; description?: string } }[];
  [key: string]: unknown;
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

/** A scripted turn: a text reply, or tool calls. */
export type Turn =
  | { text: string }
  | { tool: string; args?: Record<string, unknown> }
  | { tools: { name: string; args?: Record<string, unknown> }[] };

export interface FakeOpenAiOptions {
  /** The answer to each request (default: `defaultReply`). */
  reply?: (req: ChatRequest) => Turn;
  /** Delays every response (concurrent conversations then overlap). */
  delayMs?: number;
  /** The models `GET /v1/models` lists (default: `["fake-model"]`). */
  models?: string[];
  /** Port to listen on (default: one the OS picks), on 127.0.0.1 unless `host` says otherwise. */
  port?: number;
  host?: string;
}

/** The text of a message's content (a string, or text parts). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("");
  return "";
}

/** The last user message's text. */
export const lastUserText = (req: ChatRequest) =>
  textOf([...req.messages].reverse().find((m) => m.role === "user")?.content);

/** Tool results already in the conversation (role `tool`). */
export const toolResults = (req: ChatRequest) =>
  req.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));

/**
 * The default script: with tools offered and none answered yet, call the first one; once a tool
 * answered, reply with its result; otherwise echo the user (`fake-model heard: …`).
 */
export function defaultReply(req: ChatRequest): Turn {
  const results = toolResults(req);
  if (results.length) return { text: `The tool said: ${results.join("; ")}` };
  const tool = req.tools?.[0]?.function.name;
  if (tool) return { tool, args: {} };
  return { text: `fake-model heard: ${lastUserText(req)}` };
}

/** Text split into the deltas a streamed reply sends (a word at a time). */
const deltas = (text: string) => text.match(/\S+\s*|\s+/g) ?? [""];

export interface FakeOpenAi {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  /** `<baseUrl>/chat/completions` */
  chatUrl: string;
  /** Chat requests, in arrival order. */
  requests: ChatRequest[];
  /** The `authorization` header of each chat request. */
  authorizations: (string | undefined)[];
  /** Holds the next chat response until `release()`; `arrived` resolves when it came in. */
  holdNext(): { arrived: Promise<void>; release: () => void };
  close(): Promise<void>;
}

export async function startFakeOpenAi(opts: FakeOpenAiOptions = {}): Promise<FakeOpenAi> {
  const reply = opts.reply ?? defaultReply;
  const models = opts.models ?? ["fake-model"];
  const requests: ChatRequest[] = [];
  const authorizations: (string | undefined)[] = [];
  let hold: { released: Promise<void>; entered: () => void } | undefined;

  const server: Server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && path.endsWith("/models")) {
      json(200, {
        object: "list",
        data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "fake" })),
      });
      return;
    }
    if (req.method === "POST" && path.endsWith("/embeddings")) {
      const body = JSON.parse(await readBody(req)) as { input: string | string[]; model: string };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      json(200, {
        object: "list",
        model: body.model,
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: embed(text) })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      json(404, { error: { message: `fake-openai: no route ${req.method} ${path}` } });
      return;
    }
    const body = JSON.parse(await readBody(req)) as ChatRequest;
    requests.push(body);
    authorizations.push(req.headers.authorization);
    const h = hold;
    hold = undefined;
    if (h) {
      h.entered();
      await h.released;
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const turn = reply(body);
    const n = requests.length;
    const id = `chatcmpl-${n}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const calls =
      "text" in turn
        ? []
        : ("tools" in turn ? turn.tools : [{ name: turn.tool, args: turn.args }]).map((c, i) => ({
            index: i,
            id: `call_${n}_${i}`,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }));
    const finish = calls.length ? "tool_calls" : "stop";
    const message = calls.length
      ? { role: "assistant", content: null, tool_calls: calls }
      : { role: "assistant", content: (turn as { text: string }).text };
    if (!body.stream) {
      json(200, {
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (choice: unknown, extra: Record<string, unknown> = {}) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [choice], ...extra })}\n\n`,
      );
    if (calls.length) {
      chunk({ index: 0, delta: { role: "assistant", content: null }, finish_reason: null });
      // Each call as OpenAI streams it: the head (id, name), then the arguments.
      for (const c of calls) {
        chunk({
          index: 0,
          delta: {
            tool_calls: [
              {
                index: c.index,
                id: c.id,
                type: "function",
                function: { name: c.function.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        });
        chunk({
          index: 0,
          delta: {
            tool_calls: [{ index: c.index, function: { arguments: c.function.arguments } }],
          },
          finish_reason: null,
        });
      }
    } else {
      chunk({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null });
      for (const d of deltas(message.content as string))
        chunk({ index: 0, delta: { content: d }, finish_reason: null });
    }
    chunk({ index: 0, delta: {}, finish_reason: finish });
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://${opts.host ?? "127.0.0.1"}:${port}/v1`;
  return {
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    requests,
    authorizations,
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

/** A deterministic 8-dimensional unit vector for a text. */
function embed(text: string): number[] {
  const v = new Array<number>(8).fill(0);
  for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
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
