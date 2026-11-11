// The page's side of the Flue agents. The agents run in the studio Worker (studio/), on CellB in
// the runner: a Workspace cell holds a copy of the project and the Biscuit root key, an Agent
// cell runs a Flue agent loop whose tools hold only a capability. The page owns the real folder,
// so it is the Workspace's admin:
//
//   send(prompt)  1. sync: the project's files into the Workspace (unchanged files cost nothing)
//                 2. a session token for the chosen mode (yolo · plan · readonly), cached
//                 3. the run, with an optional narrowing (a scope such as "client"), the model
//                    and the person's key (x-llm-token)
//                 4. while it runs: its progress events, and the Workspace's journal of what the
//                    agent changed, applied to the folder (on disk when it is open)
//
// Host calls (the agent's run_app, read_logs, http_request) come back through the runner; the
// page answers them after applying the journal, so the app runs with the agent's changes.

import type { AgentEvent } from "./events";

export type AgentMode = "yolo" | "plan" | "readonly";

export interface ModelChoice {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface StudioReply<T = unknown> {
  status: number;
  value?: T;
  error?: string;
}

export type StudioFetch = (
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<StudioReply>;

/** The model as the studio's agent loop names it (pi-ai's APIs). */
export function llmOf(m: ModelChoice) {
  if (m.provider === "anthropic")
    return {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: m.model,
      maxTokens: 16000,
    };
  return {
    api: "openai-completions",
    baseUrl: (m.baseUrl || "http://localhost:11434/v1").replace(/\/+$/, ""),
    model: m.model,
  };
}

export interface Change {
  seq: number;
  path: string;
  kind: "write" | "delete" | "mkdir";
  text?: string;
  $b64?: string;
}

export interface FlueAgentOptions {
  studio: StudioFetch;
  /** The admin key of the studio (the page owns the Workspace). */
  adminKey: string;
  /** The Workspace's name: one per project. */
  workspace: () => string;
  /** The project's files now. */
  files: () => Map<string, Uint8Array>;
  /** The project's own instructions for agents (AGENTS.md), added to the agent's prompt. */
  instructions?: () => string | undefined;
  /** Applies what the agent changed to the project (and the folder on disk). */
  apply: (changes: Change[]) => Promise<void>;
  pollMs?: number;
}

const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const isText = (b: Uint8Array) => {
  if (b.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

export interface FlueRunResult {
  reply: string;
  stopReason: string;
  error?: string;
  turns: number;
}

export function createFlueAgent(opts: FlueAgentOptions) {
  const admin = { authorization: `Bearer ${opts.adminKey}` };
  const tokens = new Map<string, string>();
  let cursor: number | undefined;
  let workspaceName: string | undefined;
  let pulling: Promise<void> = Promise.resolve();

  const ok = <T>(r: StudioReply, what: string): T => {
    if (r.status >= 400) throw new Error(`${what}: ${r.error ?? r.status}`);
    return r.value as T;
  };

  async function sync() {
    const ws = opts.workspace();
    if (ws !== workspaceName) {
      workspaceName = ws;
      tokens.clear();
      cursor = undefined;
    }
    const files: Record<string, string | { $b64: string }> = {};
    for (const [p, b] of opts.files())
      files[p] = isText(b) ? new TextDecoder().decode(b) : { $b64: toB64(b) };
    const r = ok<{ cursor: number }>(
      await opts.studio(`/api/w/${encodeURIComponent(ws)}/sync`, {
        method: "POST",
        headers: admin,
        body: { files, prune: true },
      }),
      "sync",
    );
    // Changes before this sync are the folder's already.
    cursor ??= r.cursor;
  }

  async function token(mode: AgentMode) {
    const ws = opts.workspace();
    let t = tokens.get(mode);
    if (!t) {
      const s = ok<{ token: string }>(
        await opts.studio(`/api/w/${encodeURIComponent(ws)}/sessions`, {
          method: "POST",
          headers: admin,
          body: { user: "owner", rights: ["/"], mode, model: true },
        }),
        "session",
      );
      t = s.token;
      tokens.set(mode, t);
    }
    return t;
  }

  /** Applies the journal's new entries (one pull at a time). */
  function pull(): Promise<void> {
    pulling = pulling.then(async () => {
      if (cursor === undefined || !workspaceName) return;
      const r = ok<{ cursor: number; changes: Change[] }>(
        await opts.studio(`/api/w/${encodeURIComponent(workspaceName)}/changes?since=${cursor}`, {
          headers: admin,
        }),
        "changes",
      );
      if (r.changes.length) await opts.apply(r.changes);
      cursor = r.cursor;
    });
    return pulling;
  }

  function projectInstructions() {
    const text = opts.instructions?.();
    return text ? `The project's AGENTS.md:\n<agents_md>\n${text}\n</agents_md>` : undefined;
  }

  async function send(
    prompt: string,
    run: {
      mode: AgentMode;
      scope?: string;
      model: ModelChoice;
      session?: string;
      instructions?: string;
      onEvent: (e: AgentEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<FlueRunResult> {
    await sync();
    const t = await token(run.mode);
    const runId = crypto.randomUUID();
    const agentName = `agent-${opts.workspace()}`;
    const scope = run.scope?.trim().replace(/^\/+|\/+$/g, "");
    let seen = 0;
    let done = false;
    const follow = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
        const p = await opts.studio(`/api/agents/${agentName}/runs/${runId}?since=${seen}`);
        const events = (p.value as { events?: (AgentEvent & { n: number })[] })?.events ?? [];
        for (const e of events) {
          seen = e.n;
          run.onEvent(e);
        }
        await pull().catch(() => {});
      }
    })();
    const onAbort = () =>
      void opts.studio(`/api/agents/${agentName}/runs/${runId}/stop`, { method: "POST" });
    run.signal?.addEventListener("abort", onAbort);
    try {
      const r = await opts.studio(`/api/agents/${agentName}/run`, {
        method: "POST",
        headers: { "x-llm-token": run.model.apiKey || "no-key-local-model" },
        body: {
          workspace: opts.workspace(),
          token: t,
          narrow: scope ? { scope: `/${scope}` } : undefined,
          task: {
            prompt,
            runId,
            session: run.session,
            instructions: run.instructions ?? projectInstructions(),
            llm: llmOf(run.model),
          },
        },
      });
      return ok<FlueRunResult>(r, "agent");
    } finally {
      run.signal?.removeEventListener("abort", onAbort);
      done = true;
      await follow.catch(() => {});
      // The last events and changes.
      const p = await opts
        .studio(`/api/agents/${agentName}/runs/${runId}?since=${seen}`)
        .catch(() => undefined);
      for (const e of (p?.value as { events?: AgentEvent[] })?.events ?? []) run.onEvent(e);
      await pull().catch(() => {});
    }
  }

  return { send, sync, pull };
}

export type FlueAgent = ReturnType<typeof createFlueAgent>;
