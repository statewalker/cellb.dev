/**
 * Workers AI (`env.AI`, wrangler `ai: { binding }`) served by an OpenAI-compatible endpoint:
 * a local llama.cpp or Ollama server, a hosted API, or a test's fake. Text generation and
 * embeddings; other model kinds (images, speech) are refused.
 *
 *   env.AI.run(model, { prompt } | { messages, tools?, stream?, ... }, options?)
 *     → { response, tool_calls?, usage }           (Workers AI's shape)
 *     → ReadableStream of `data: {"response": …}`  (with `stream: true`)
 *     → the endpoint's Response as is              (with `returnRawResponse`: Flue's path)
 *   env.AI.run(model, { text })                    → { shape, data, pooling } (embeddings)
 */

/** Plain data, so that it can travel to a browser worker with the rest of a project's options. */
export interface WorkersAiOptions {
  /** The endpoint's base URL, up to `/v1` (e.g. `http://127.0.0.1:8080/v1`). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer …`. */
  apiKey?: string;
  /**
   * Workers AI model id (`@cf/meta/llama-3.1-8b-instruct`) → the endpoint's model name; `"*"`
   * names the model for every id not listed. Ids that map to nothing are sent as they are.
   */
  models?: Record<string, string>;
}

/** `env.AI.run`'s third argument (the parts cellb honours; `gateway` is accepted and ignored). */
export interface AiRunOptions {
  returnRawResponse?: boolean;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  gateway?: unknown;
}

type Json = Record<string, unknown>;

/** Workers AI's error: `run` rejects with it when the endpoint answers with an error status. */
export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export function workersAi(opts: WorkersAiOptions, fetchImpl: typeof fetch = (r, i) => fetch(r, i)) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const modelOf = (id: string) => opts.models?.[id] ?? opts.models?.["*"] ?? id;
  const post = (path: string, body: Json, o: AiRunOptions) =>
    fetchImpl(`${base}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...o.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: o.signal,
    });
  const failed = async (res: Response) =>
    new AiError(`Workers AI: the model endpoint answered ${res.status}: ${await res.text()}`);

  async function chat(model: string, inputs: Json, o: AiRunOptions) {
    const { prompt, messages, tools, stream, raw: _raw, lora: _lora, ...rest } = inputs;
    const body: Json = {
      ...rest,
      model: modelOf(model),
      messages: messages ?? [{ role: "user", content: String(prompt) }],
      stream: !!stream,
    };
    // Workers AI tools are { name, description, parameters }; OpenAI's are wrapped in `function`.
    if (Array.isArray(tools))
      body.tools = tools.map((t: Json) =>
        t.type === "function"
          ? t
          : {
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            },
      );
    const res = await post("chat/completions", body, o);
    if (o.returnRawResponse) return res;
    if (!res.ok) throw await failed(res);
    if (stream && res.body) return res.body.pipeThrough(toWorkersAiStream());
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
      usage?: unknown;
    };
    const message = json.choices?.[0]?.message ?? {};
    const out: Json = { response: message.content ?? "" };
    if (message.tool_calls?.length) out.tool_calls = message.tool_calls.map(toWorkersAiToolCall);
    if (json.usage) out.usage = json.usage;
    return out;
  }

  async function embed(model: string, inputs: Json, o: AiRunOptions) {
    const res = await post("embeddings", { model: modelOf(model), input: inputs.text }, o);
    if (o.returnRawResponse) return res;
    if (!res.ok) throw await failed(res);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const data = json.data.map((d) => d.embedding);
    return { shape: [data.length, data[0]?.length ?? 0], data, pooling: "mean" };
  }

  return {
    async run(model: string, inputs: unknown, options: AiRunOptions = {}): Promise<unknown> {
      if (!inputs || typeof inputs !== "object")
        throw new TypeError("Workers AI: run(model, inputs) takes an inputs object");
      const i = inputs as Json;
      if ("messages" in i || "prompt" in i) return chat(model, i, options);
      if ("text" in i) return embed(model, i, options);
      throw new AiError(
        `Workers AI: cellb serves text generation ({ prompt } or { messages }) and embeddings ({ text }) only; ${model} got neither`,
      );
    },
    /** Workers AI's AI Gateway: not available, `run` ignores its `gateway` option. */
    gateway(): never {
      throw new AiError("Workers AI: AI Gateway is not supported by cellb");
    },
  };
}

interface OpenAiToolCall {
  /** In a streamed chunk: which call a fragment belongs to. */
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** Workers AI's tool call: `{ name, arguments }`, with the arguments parsed. */
function toWorkersAiToolCall(tc: OpenAiToolCall) {
  let args: unknown = tc.function?.arguments ?? {};
  if (typeof args === "string")
    try {
      args = JSON.parse(args || "{}");
    } catch {
      // not JSON: passed on as the model wrote it
    }
  return { name: tc.function?.name ?? "", arguments: args };
}

/**
 * OpenAI chat-completion chunks (`data: {"choices":[{"delta":…}]}`) → Workers AI's stream
 * (`data: {"response":"…"}`, then `data: [DONE]`), usage riding along. Tool calls stream in
 * fragments (a name, then pieces of the arguments' JSON, keyed by `index`): they are gathered and
 * sent whole, once, before `[DONE]`, as `{ response: "", tool_calls: [{ name, arguments }] }`.
 */
function toWorkersAiStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  const calls = new Map<number, { name: string; arguments: string }>();
  const emit = (c: TransformStreamDefaultController<Uint8Array>, data: string) =>
    c.enqueue(encoder.encode(`data: ${data}\n\n`));
  const finish = (c: TransformStreamDefaultController<Uint8Array>) => {
    if (done) return;
    done = true;
    if (calls.size) {
      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => toWorkersAiToolCall({ function: call }));
      emit(c, JSON.stringify({ response: "", tool_calls: toolCalls }));
    }
    emit(c, "[DONE]");
  };
  const line = (c: TransformStreamDefaultController<Uint8Array>, l: string) => {
    if (!l.startsWith("data:")) return;
    const data = l.slice(5).trim();
    if (data === "[DONE]") return finish(c);
    let chunk: {
      choices?: { delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
      usage?: unknown;
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    const delta = chunk.choices?.[0]?.delta;
    for (const [i, tc] of (delta?.tool_calls ?? []).entries()) {
      const index = tc.index ?? i;
      const call = calls.get(index) ?? { name: "", arguments: "" };
      call.name += tc.function?.name ?? "";
      call.arguments += tc.function?.arguments ?? "";
      calls.set(index, call);
    }
    const out: Json = { response: delta?.content ?? "" };
    if (chunk.usage) out.usage = chunk.usage;
    if (out.response === "" && !out.usage) return;
    emit(c, JSON.stringify(out));
  };
  return new TransformStream({
    transform(bytes, c) {
      buffer += decoder.decode(bytes, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        line(c, buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    },
    flush(c) {
      buffer += decoder.decode();
      if (buffer) line(c, buffer.trim());
      finish(c);
    },
  });
}
