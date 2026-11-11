// The in-tab coding agent: a model, the sandbox's tools, and a loop between them.
//
// Bring your own key: the model is called from this tab, the key stays in the tab (local
// storage, if the person asks), and the tools act on the open project exactly as the buttons do.
// Two kinds of model endpoint:
//
//   anthropic   Claude through the Anthropic SDK (browser access is the person's own choice:
//               their key, their tab)
//   openai      any OpenAI-compatible Chat Completions endpoint: a local model (Ollama,
//               LM Studio, llama.cpp), a gateway (LiteLLM, OpenRouter, httpeers' llm service),
//               or the scripted fake model the e2e test uses
//
// One loop for both: send the conversation, run the tool calls the model makes, send the
// results back, until the model answers without a tool call (or the step limit, or Stop).

import Anthropic from "@anthropic-ai/sdk";
import { callTool, type Tool } from "./tools";

export type ProviderKind = "anthropic" | "openai";

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string;
  /** OpenAI-compatible: the API root, e.g. http://localhost:11434/v1. */
  baseUrl?: string;
}

export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-oss:20b",
};

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: string }
  | { type: "done"; steps: number }
  | { type: "error"; message: string };

export const SYSTEM_PROMPT = `You are the coding agent of CellB sandbox, a browser IDE. The person has a project open in this tab; you change it and run it with your tools.

The platform:
- Server: wrangler.jsonc with a "main" module — a Cloudflare-Workers-style app (fetch handler, Durable Objects with SQLite storage, KV, D1, R2, Queues, Workflows). It is bundled and run in the browser tab by CellB; the same code later deploys unchanged to Cloudflare, celld or cellb on Node.
- Client: client/index.html (or public/, or the root) whose <script src> names TS/TSX/JS/JSX files, compiled module by module in the browser. npm imports resolve from package.json (add a dependency there before importing it).
- The client calls the server with relative URLs, e.g. fetch("api/items"): the app runs under a sub-path here.
- No shell, no node_modules: there is nothing to install.

How to work:
1. project_info, then list_files; read AGENTS.md when the project has one and follow it.
2. Read the files you will change. Prefer edit_file for changes inside a file; write_file for new files.
3. After changes, run_app, and check the server with http_request. If the build or a request fails, read_logs, fix, and run again.
4. End with a short summary of what changed and how to try it. Keep explanations brief.`;

export interface AgentSessionOptions {
  config: ModelConfig;
  tools: () => Tool[];
  /** Project instructions appended to the system prompt (AGENTS.md). */
  instructions?: () => string | undefined;
  maxSteps?: number;
  /** For tests and proxies: the fetch the model client uses. */
  fetch?: typeof fetch;
}

/** A conversation with the agent; `send` runs one turn (with its tool calls). */
export interface AgentSession {
  send(text: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void>;
}

function systemOf(opts: AgentSessionOptions): string {
  const extra = opts.instructions?.();
  return extra
    ? `${SYSTEM_PROMPT}\n\nThe project's AGENTS.md:\n<agents_md>\n${extra}\n</agents_md>`
    : SYSTEM_PROMPT;
}

const preview = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > 4000 ? `${s.slice(0, 4000)}\n…(${s.length} chars)` : s;
};

async function runTool(
  tools: Tool[],
  id: string,
  name: string,
  input: unknown,
  onEvent: (e: AgentEvent) => void,
): Promise<{ ok: boolean; text: string }> {
  onEvent({ type: "tool_call", id, name, input });
  const out = await callTool(tools, name, (input as Record<string, unknown>) ?? {});
  const text = out.ok ? JSON.stringify(out.result) : `Error: ${out.error}`;
  onEvent({
    type: "tool_result",
    id,
    name,
    ok: out.ok,
    output: preview(out.ok ? out.result : out.error),
  });
  return { ok: out.ok, text };
}

// ---------------------------------------------------------------------------------------------
// Claude, through the Anthropic SDK.

function anthropicSession(opts: AgentSessionOptions): AgentSession {
  const client = new Anthropic({
    apiKey: opts.config.apiKey,
    // The key is the person's own and never leaves their tab for anything but the API.
    dangerouslyAllowBrowser: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  return {
    async send(text, onEvent, signal) {
      messages.push({ role: "user", content: text });
      const max = opts.maxSteps ?? 40;
      let steps = 0;
      try {
        while (steps < max) {
          steps++;
          const tools = opts.tools();
          const response = await client.beta.messages.create(
            {
              model: opts.config.model || DEFAULT_MODELS.anthropic,
              max_tokens: 16000,
              system: systemOf(opts),
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
              })),
              messages,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            } as Anthropic.Beta.MessageCreateParamsNonStreaming,
            { signal },
          );
          messages.push({ role: "assistant", content: response.content });
          for (const block of response.content)
            if (block.type === "text" && block.text.trim())
              onEvent({ type: "text", text: block.text });
          if (response.stop_reason === "refusal") {
            onEvent({ type: "error", message: "the model declined this request" });
            return;
          }
          if (response.stop_reason === "pause_turn") continue;
          const calls = response.content.filter(
            (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
          );
          if (calls.length === 0) break;
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of calls) {
            const r = await runTool(tools, call.id, call.name, call.input, onEvent);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: r.text,
              is_error: !r.ok,
            });
          }
          messages.push({ role: "user", content: results });
        }
        onEvent({ type: "done", steps });
      } catch (err) {
        onEvent({ type: "error", message: errorText(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Any OpenAI-compatible Chat Completions endpoint.

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function openaiSession(opts: AgentSessionOptions): AgentSession {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const messages: OpenAIMessage[] = [];
  const base = (opts.config.baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  return {
    async send(text, onEvent, signal) {
      messages.push({ role: "user", content: text });
      const max = opts.maxSteps ?? 40;
      let steps = 0;
      try {
        while (steps < max) {
          steps++;
          const tools = opts.tools();
          const res = await f(`${base}/chat/completions`, {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              ...(opts.config.apiKey ? { authorization: `Bearer ${opts.config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: opts.config.model || DEFAULT_MODELS.openai,
              messages: [{ role: "system", content: systemOf(opts) }, ...messages],
              tools: tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
              stream: false,
            }),
          });
          if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 500)}`);
          const data = (await res.json()) as {
            choices: { message: OpenAIMessage; finish_reason?: string }[];
          };
          const msg = data.choices?.[0]?.message;
          if (!msg) throw new Error("the endpoint answered without a message");
          messages.push({
            role: "assistant",
            content: msg.content ?? null,
            tool_calls: msg.tool_calls,
          });
          if (msg.content?.trim()) onEvent({ type: "text", text: msg.content });
          if (!msg.tool_calls?.length) break;
          for (const call of msg.tool_calls) {
            let input: unknown = {};
            try {
              input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: "Error: the arguments are not valid JSON",
              });
              continue;
            }
            const r = await runTool(tools, call.id, call.function.name, input, onEvent);
            messages.push({ role: "tool", tool_call_id: call.id, content: r.text });
          }
        }
        onEvent({ type: "done", steps });
      } catch (err) {
        onEvent({ type: "error", message: errorText(err) });
      }
    },
  };
}

function errorText(err: unknown): string {
  if ((err as Error)?.name === "AbortError" || err instanceof Anthropic.APIUserAbortError)
    return "stopped";
  if (err instanceof Anthropic.AuthenticationError) return "the API key was refused";
  if (err instanceof Anthropic.RateLimitError) return "rate limited: try again in a moment";
  if (err instanceof Anthropic.APIError) return `model API error ${err.status}: ${err.message}`;
  return (err as Error)?.message ?? String(err);
}

export function createAgentSession(opts: AgentSessionOptions): AgentSession {
  return opts.config.provider === "anthropic" ? anthropicSession(opts) : openaiSession(opts);
}
