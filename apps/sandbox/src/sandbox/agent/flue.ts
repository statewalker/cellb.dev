// The page's side of the Flue agents. The agents run in the studio worker (studio/ on CellB):
// an Agent cell runs a Flue agent loop whose tools hold only a capability on the project's real
// files (the FilesApi the studio worker owns, filtered by the token's Datalog). The page:
//
//   send(prompt)  a token for the chosen rights (yolo · plan · readonly, from the session), an
//                 optional narrowing (a scope such as "client"), the model and the person's key
//                 (x-llm-token); while the run is under way, its progress events.
//
// Nothing is copied or mirrored: the agent's writes are the files' writes, and the page sees them
// as it sees any change (the studio's change notices, its watcher).

import { NO_GIT } from "../../../studio/src/capfs/policy";
import type { AgentMode, StudioConnection } from "../session";
import type { AgentEvent } from "./events";

export type { AgentMode };

export interface ModelChoice {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
}

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

export interface FlueRunResult {
  reply: string;
  stopReason: string;
  error?: string;
  turns: number;
}

export interface FlueAgentOptions {
  studio: Pick<StudioConnection, "request">;
  /** The open project: its workspace and a token per mode (with the model right). */
  project: () =>
    | { ws: string; tokenFor(mode: AgentMode, o?: { model?: boolean }): Promise<string> }
    | undefined;
  /** The project's own instructions for agents (AGENTS.md), added to the agent's prompt. */
  instructions?: () => string | undefined;
  pollMs?: number;
}

export function createFlueAgent(opts: FlueAgentOptions) {
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
    const project = opts.project();
    if (!project) throw new Error("no project is open");
    const token = await project.tokenFor(run.mode, { model: true });
    const runId = crypto.randomUUID();
    const agent = `agent-${project.ws}`;
    const scope = run.scope?.trim().replace(/^\/+|\/+$/g, "");
    let seen = 0;
    let done = false;
    const drain = async () => {
      const p = await opts.studio.request<{ events?: (AgentEvent & { n: number })[] }>(
        `/api/agents/${agent}/runs/${runId}?since=${seen}`,
      );
      for (const e of p.value?.events ?? []) {
        seen = e.n;
        run.onEvent(e);
      }
    };
    const follow = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 400));
        if (!done) await drain().catch(() => {});
      }
    })();
    const onAbort = () =>
      void opts.studio.request(`/api/agents/${agent}/runs/${runId}/stop`, { method: "POST" });
    run.signal?.addEventListener("abort", onAbort);
    try {
      const r = await opts.studio.request<FlueRunResult>(`/api/agents/${agent}/run`, {
        headers: { "x-llm-token": run.model.apiKey || "no-key-local-model" },
        body: {
          workspace: project.ws,
          token,
          // The history (.git) is the owner's: no agent token reaches it.
          narrow: { ...(scope ? { scope: `/${scope}` } : {}), datalog: NO_GIT },
          task: {
            prompt,
            runId,
            session: run.session,
            instructions: run.instructions ?? projectInstructions(),
            llm: llmOf(run.model),
          },
        },
      });
      if (r.status >= 400 || !r.value) throw new Error(`agent: ${r.error ?? r.status}`);
      return r.value;
    } finally {
      run.signal?.removeEventListener("abort", onAbort);
      done = true;
      await follow.catch(() => {});
      await drain().catch(() => {});
    }
  }

  return { send };
}

export type FlueAgent = ReturnType<typeof createFlueAgent>;
