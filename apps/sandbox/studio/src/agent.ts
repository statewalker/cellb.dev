// The agent cell: one Agent Durable Object per agent. It receives a capability (an RPC stub of
// the Workspace's FilteredFiles), never the store, the token's key or the folder, and runs a
// Flue agent loop on it (agent-loop.ts). Progress of each run is kept in memory for the host to
// poll while the run is under way.

import { DurableObject } from "cloudflare:workers";
import { type AgentEvent, type AgentRunRequest, runAgentLoop } from "./agent-loop.ts";
import { type FilesStub, StubCap } from "./capfs/caps.ts";
import { studioHost } from "./host-tools.ts";

interface RunState {
  events: (AgentEvent & { n: number })[];
  done: boolean;
  controller: AbortController;
}

export class Agent extends DurableObject {
  #runs = new Map<string, RunState>();

  /** Runs a prompt with this capability; `runId` lets the host follow it (progress) and stop it. */
  async run(files: FilesStub, req: AgentRunRequest & { runId?: string }, llmToken?: string) {
    const cap = new StubCap(files);
    const runId = req.runId ?? crypto.randomUUID();
    const state: RunState = { events: [], done: false, controller: new AbortController() };
    this.#runs.set(runId, state);
    if (this.#runs.size > 20) this.#runs.delete(this.#runs.keys().next().value as string);
    const scope = await cap.revocationId();
    try {
      return await runAgentLoop(cap, req, this.env as never, this.ctx.storage as never, {
        scope,
        sandboxId: `agent-${runId}`,
        llmToken,
        host: studioHost(),
        signal: state.controller.signal,
        onEvent: (e) => state.events.push({ ...e, n: state.events.length + 1 }),
      });
    } finally {
      state.done = true;
    }
  }

  progress(runId: string, since = 0) {
    const s = this.#runs.get(runId);
    if (!s) return { events: [], done: true, unknown: true };
    return { events: s.events.filter((e) => e.n > since), done: s.done };
  }

  stop(runId: string) {
    this.#runs.get(runId)?.controller.abort();
    return { stopped: !!this.#runs.get(runId) };
  }
}
