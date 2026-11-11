// A Flue agent on the capability file system: the loop Flue is built on (pi-agent-core, pi-ai
// for the model call) with Flue's own model-facing tools (read, write, edit, grep, glob, bash)
// over a just-bash sandbox whose only file system is the capability (CapFs). Every file access
// the model asks for is a capability call, authorized in the Workspace cell by the token's
// Datalog. Adapted from statewalker-sandbox/apps/flue-capfs-do/src/agent-loop.ts.
//
// studio: three differences.
//   - Host tools: when the host offers them (the sandbox's runner does), the model also gets
//     run_app, read_logs and http_request, to run and test the app it changes. They go to the
//     host, which applies the agent's writes to its folder before it runs anything.
//   - The model may come with the run (`llm` + the caller's key), when the deployment allows it
//     (LLM_FROM_REQUEST="1": a browser tab running its own agent with its own key).
//   - Progress: each tool call and reply is reported as it happens (`onEvent`).

import { Agent as LoopAgent } from "@earendil-works/pi-agent-core";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import { registerApiProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  bash as flueBash,
} from "@flue/runtime";
import { Bash } from "just-bash/browser";
import { trimHistory } from "./capfs/agent-history.ts";
import { CapFs } from "./capfs/capfs.ts";
import type { Cap } from "./capfs/caps.ts";
import { rgForFlue } from "./capfs/flue-compat.ts";
import { type LlmConfig, llmConfig, llmCredentials, redactor } from "./capfs/llm-config.ts";
import { hostTools, type StudioHost } from "./host-tools.ts";

export interface AgentRunRequest {
  prompt: string;
  instructions?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Keep the conversation under this name (per capability) and continue it next time. */
  session?: string;
  cwd?: string;
  /** The model, when the deployment lets a run bring it (LLM_FROM_REQUEST). */
  llm?: LlmConfig;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: string };

export interface AgentLoopEnv {
  LLM?: unknown;
  LLM_API_KEY?: string;
  LLM_FROM_REQUEST?: string;
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const SESSION_MESSAGES = 200;
const SESSION_BYTES = 1024 * 1024;
const TEXT_LIMIT = 4000;
const INPUT_LIMIT = 100_000;
const CHARS_PER_TOKEN = 3;

export const STUDIO_INSTRUCTIONS = `You are the coding agent of CellB sandbox, a browser IDE. You work on the open project through your tools; paths are absolute from the project's root (/server/index.ts). You see and change only what your capability allows: a denied operation (EACCES) is a limit set by the person, not an error to work around.

The platform:
- Server: /wrangler.jsonc with a "main" module — a Cloudflare-Workers-style app (fetch handler, Durable Objects with SQLite storage, KV, D1, R2, Queues, Workflows), run in the browser tab by CellB; the same code deploys unchanged to Cloudflare, celld or cellb on Node.
- Client: /client/index.html (or /public, or the root) whose <script src> names TS/TSX/JS/JSX files, compiled module by module. npm imports resolve from package.json (add a dependency there first).
- The client calls the server with relative URLs, e.g. fetch("api/items").
- The bash tool is a sandboxed shell over the project's files (ls, cat, grep, find, sed…): there is no node, npm or network.

How to work: read AGENTS.md when present; read before you change; prefer edit to write for existing files; when the change is complete, run_app and check it with http_request; if it fails, read_logs, fix, run again. End with a short summary.`;

let providersRegistered = false;

function modelOf(c: LlmConfig, extraHeaders: Record<string, string> = {}) {
  if (!providersRegistered) {
    // Only the APIs a config can name (the others pull in providers that import node:fs).
    for (const [api, m] of [
      ["openai-completions", openaiCompletions],
      ["openai-responses", openaiResponses],
      ["anthropic-messages", anthropicMessages],
    ] as const) {
      registerApiProvider(
        { api, stream: m.stream as never, streamSimple: m.streamSimple as never },
        "cellb-sandbox-studio",
      );
    }
    providersRegistered = true;
  }
  return {
    id: c.model,
    name: c.model,
    api: c.api ?? "openai-completions",
    provider: "studio",
    baseUrl: c.baseUrl,
    headers: { ...c.headers, ...extraHeaders },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: c.contextWindow ?? 128_000,
    maxTokens: c.maxTokens ?? 8192,
  };
}

const clip = (s: string, n = TEXT_LIMIT) =>
  s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s;
type Content = { type: string; text?: string; name?: string; arguments?: unknown; id?: string };
type Message = {
  role: string;
  content?: Content[] | string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
};
const textOf = (m: Message | undefined) =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c) => c.text ?? "").join("");

/** The model of a run: the deployment's (LLM), or the run's own when the deployment allows it. */
export function runModel(env: AgentLoopEnv, req: AgentRunRequest): LlmConfig {
  const deployed = llmConfig(env);
  if (req.llm) {
    if (env.LLM_FROM_REQUEST !== "1")
      throw new Error("EACCES: this deployment does not take a model from the request");
    return llmConfig({ LLM: req.llm }) as LlmConfig;
  }
  if (!deployed) throw new Error("ENOSYS: no model: give one with the run, or set LLM");
  return deployed;
}

export async function runAgentLoop(
  cap: Cap,
  req: AgentRunRequest,
  env: AgentLoopEnv,
  storage: Storage,
  opts: {
    scope: string;
    sandboxId: string;
    llmToken?: string;
    host?: StudioHost;
    onEvent?: (e: AgentEvent) => void;
    signal?: AbortSignal;
  },
) {
  if (typeof req.prompt !== "string" || !req.prompt) throw new Error("EINVAL: prompt is required");
  if (req.prompt.length > INPUT_LIMIT) throw new Error("EINVAL: prompt is too long");
  if (req.instructions !== undefined && String(req.instructions).length > INPUT_LIMIT)
    throw new Error("EINVAL: instructions are too long");
  const config = runModel(env, req);
  // A run that brings its model brings its key: the caller's token is the API key.
  const credentials = llmCredentials(
    req.llm ? { ...config, callerToken: "allow" } : config,
    req.llm ? undefined : env.LLM_API_KEY,
    opts.llmToken,
  );
  const redact = redactor([credentials.apiKey, opts.llmToken, env.LLM_API_KEY]);
  const metered = !req.llm;
  // The capability must carry the model right (decided in the Workspace cell).
  await cap.model("grant", metered);
  const emit = opts.onEvent ?? (() => {});

  const sandbox = await flueBash(
    () =>
      new Bash({
        fs: new CapFs(cap) as never,
        cwd: req.cwd ?? "/",
        customCommands: [rgForFlue],
      }) as never,
  ).createSandbox({ id: opts.sandboxId });
  const tools = [
    ...[
      createReadTool,
      createWriteTool,
      createEditTool,
      createGrepTool,
      createGlobTool,
      createBashTool,
    ].map(
      (make) =>
        make(sandbox) as unknown as {
          name: string;
          execute: (...a: unknown[]) => Promise<unknown>;
        },
    ),
    ...(opts.host ? hostTools(opts.host) : []),
  ];

  const model = modelOf(config, credentials.headers);
  const contextBytes = Math.max(
    (model.contextWindow - model.maxTokens) * CHARS_PER_TOKEN,
    16 * 1024,
  );
  const sessionKey = req.session ? `agent-session:${opts.scope}:${String(req.session)}` : undefined;
  const stored = (sessionKey ? await storage.get<Message[]>(sessionKey) : undefined) ?? [];
  const history = trimHistory(stored, SESSION_MESSAGES, Math.min(SESSION_BYTES, contextBytes));

  let stopped: string | undefined;
  const agent = new LoopAgent({
    streamFn: streamSimple as never,
    getApiKey: async () => {
      if (stopped) throw new Error("stopped");
      await cap.model("reserve", metered); // the right again: a revocation stops the next turn
      return credentials.apiKey;
    },
    initialState: {
      systemPrompt: req.instructions
        ? `${STUDIO_INSTRUCTIONS}\n\n${req.instructions}`
        : STUDIO_INSTRUCTIONS,
      model: model as never,
      tools: tools as never,
      messages: history as never,
    },
  } as never);

  const maxTurns = Math.min(Math.max(Number(req.maxTurns) || 24, 1), 60);
  const timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 300_000, 1000), 900_000);
  let turns = 0;
  agent.subscribe(
    (e: {
      type: string;
      message?: Message;
      toolResults?: unknown[];
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      result?: { content?: Content[] };
      isError?: boolean;
    }) => {
      if (e.type === "tool_execution_start")
        emit({
          type: "tool_call",
          id: String(e.toolCallId),
          name: String(e.toolName),
          input: e.args,
        });
      else if (e.type === "tool_execution_end")
        emit({
          type: "tool_result",
          id: String(e.toolCallId),
          name: String(e.toolName),
          ok: !e.isError,
          output: clip((e.result?.content ?? []).map((c) => c.text ?? "").join("")),
        });
      else if (e.type === "message_end" && e.message?.role === "assistant") {
        const text = textOf(e.message).trim();
        if (text) emit({ type: "text", text });
      } else if (e.type === "turn_end") {
        if (e.message?.usage) void cap.model("charge", metered, e.message.usage).catch(() => {});
        if (stopped) return;
        turns += 1;
        if (
          turns >= maxTurns &&
          (e.message?.stopReason === "toolUse" || (e.toolResults?.length ?? 0) > 0)
        ) {
          stopped = `stopped after ${maxTurns} turns`;
          agent.abort();
        }
      }
    },
  );
  const onAbort = () => {
    stopped ??= "stopped";
    agent.abort();
  };
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    stopped ??= `stopped after ${timeoutMs} ms`;
    agent.abort();
  }, timeoutMs);
  try {
    await agent.prompt(req.prompt);
    await agent.waitForIdle();
  } catch (e) {
    if (!stopped) throw new Error(redact(String((e as Error)?.message ?? e)));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  const messages = (agent.state.messages as unknown as Message[]).filter(
    (m) => m.role !== "system",
  );
  const fresh = messages.slice(history.length);
  const assistants = fresh.filter((m) => m.role === "assistant");
  const last = assistants.at(-1);
  const answer = [...assistants]
    .reverse()
    .find((m) => m.stopReason !== "aborted" && m.stopReason !== "error");
  const providerError =
    last?.stopReason === "error"
      ? clip(redact(String(last.errorMessage ?? "error")).replace(/\b\w+:\/\/\S+/g, "<url>"), 500)
      : undefined;
  if (sessionKey)
    await storage.put(sessionKey, trimHistory(messages, SESSION_MESSAGES, SESSION_BYTES));
  return {
    reply: clip(textOf(answer)),
    stopReason: stopped ? "limit" : (last?.stopReason ?? "unknown"),
    error: [stopped, providerError].filter(Boolean).join("; ") || undefined,
    turns,
  };
}
