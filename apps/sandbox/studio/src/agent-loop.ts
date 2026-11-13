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
import { Type } from "typebox";
import { trimHistory } from "./capfs/agent-history.ts";
import { CapFs } from "./capfs/capfs.ts";
import type { Cap } from "./capfs/caps.ts";
import { rgForFlue } from "./capfs/flue-compat.ts";
import { type LlmConfig, llmConfig, llmCredentials, redactor } from "./capfs/llm-config.ts";
import { attenuationBlock } from "./capfs/policy.ts";
import { hostTools, type StudioHost } from "./host-tools.ts";
import { pythonTool } from "./python-tool.ts";
import { scriptTool } from "./script-tool.ts";

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
  LOADER?: unknown;
  TOOL_ISOLATES?: string;
  LLM?: unknown;
  LLM_API_KEY?: string;
  LLM_FROM_REQUEST?: string;
}

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const SESSION_MESSAGES = 200;
/** Agents may delegate once: a sub-agent has no delegate tool. */
const MAX_DEPTH = 1;
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
    /** How deep this agent is (0: the person's agent; a sub-agent cannot delegate again). */
    depth?: number;
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
  // Every run is metered: the session's budget (turns, tokens; none set: unlimited) is spent by
  // the person's own key as by a deployment's.
  const metered = true;
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
    ...(env.LOADER && env.TOOL_ISOLATES !== "off" ? [scriptTool(cap, env.LOADER as never)] : []),
    ...(opts.host?.python ? [pythonTool(cap, opts.host)] : []),
    ...((opts.depth ?? 0) < MAX_DEPTH ? [delegateTool()] : []),
  ];

  // Delegation: a sub-agent gets this agent's capability narrowed by one more Biscuit block (a
  // scope, read-only): it can only ever have fewer rights. It runs the same loop with the same
  // model, without a stored conversation, and its tool calls are reported as `sub:<tool>`.
  function delegateTool() {
    return {
      name: "delegate",
      label: "Delegate to a sub-agent",
      description:
        "Hands a self-contained task to a sub-agent whose file rights are narrower than yours: `scope` limits it to one folder (e.g. /client), `read_only` forbids writes. Use it to keep a step within bounds (a refactor that must not leave /client, a review that must not write). Returns the sub-agent's final answer.",
      parameters: Type.Object({
        task: Type.String({ description: "what the sub-agent must do, with all it needs to know" }),
        scope: Type.Optional(Type.String({ description: "a folder, e.g. /client" })),
        read_only: Type.Optional(Type.Boolean()),
      }),
      async execute(
        _id: string,
        params: { task: string; scope?: string; read_only?: boolean },
        signal?: AbortSignal,
      ) {
        const scope = params.scope ? `/${params.scope.replace(/^\/+|\/+$/g, "")}` : undefined;
        if (!scope && !params.read_only)
          throw new Error(
            "EINVAL: give a scope or read_only: a sub-agent's rights must be narrower",
          );
        const narrower = await cap.attenuate(
          attenuationBlock({ scope, readOnly: params.read_only }),
        );
        const out = await runAgentLoop(
          narrower,
          {
            prompt: params.task,
            llm: req.llm,
            instructions: `You are a sub-agent. Your rights: ${[scope ? `only ${scope}` : "", params.read_only ? "read-only" : ""].filter(Boolean).join(", ")}. Do the task, then answer with what you did or found.`,
            maxTurns: 12,
          },
          env,
          storage,
          {
            ...opts,
            sandboxId: `${opts.sandboxId}-sub-${crypto.randomUUID().slice(0, 8)}`,
            depth: (opts.depth ?? 0) + 1,
            signal: signal ?? opts.signal,
            onEvent: (e) =>
              emit(
                e.type === "text"
                  ? { type: "text", text: `↳ sub-agent: ${e.text}` }
                  : { ...e, name: `sub:${e.name}` },
              ),
          },
        );
        return {
          content: [
            { type: "text", text: out.error ? `${out.reply}\n(error: ${out.error})` : out.reply },
          ],
          details: undefined,
        };
      },
    };
  }

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
      try {
        // The right again (a revocation stops the next turn) and a turn from the budget.
        await cap.model("reserve", metered);
      } catch (e) {
        if (/EACCES/.test(String((e as Error)?.message ?? e)))
          stopped ??= String((e as Error).message).replace(/^(Error: )?E[A-Z]+: /, "");
        throw e;
      }
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
    // What is left of the session's model budget (null: unlimited).
    budget: (await cap.model("grant", false).catch(() => undefined)) as
      | { turnsLeft: number | null; tokensLeft: number | null }
      | undefined,
  };
}
