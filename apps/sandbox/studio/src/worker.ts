// The studio's HTTP surface (one Worker; the host reaches it through the sandbox's runner).
//
//   admin (Authorization: Bearer ADMIN_KEY): the host that owns the project
//     POST /api/w/:ws/sync               { files: {path: text | {$b64} | null}, prune? }
//     GET  /api/w/:ws/changes?since=n    what agents changed, with contents
//     POST /api/w/:ws/sessions           { user, rights, mode, model? } → { session, token }
//     GET  /api/w/:ws/sessions/:sid      mode, revocations, model budget
//     POST /api/w/:ws/sessions/:sid/mode { mode }    yolo · plan · readonly
//     POST /api/w/:ws/sessions/:sid/revoke { rid? } one capability (and its descendants), or all
//   holder (a session token, no admin key):
//     POST /api/agents/:name/run         { workspace, token, narrow?, task } (x-llm-token: the model key)
//     GET  /api/agents/:name/runs/:id?since=n   progress events
//     POST /api/agents/:name/runs/:id/stop
//   GET /api/runtime                     what this deployment offers

import { restoreNodeVersions } from "./capfs/node-probe-guard.ts";
import type { Agent } from "./agent.ts";
import type { AgentRunRequest } from "./agent-loop.ts";
import type { FilesStub } from "./capfs/caps.ts";
import { studioHost } from "./host-tools.ts";
import type { SyncValue, Workspace } from "./workspace.ts";

restoreNodeVersions();

export { Agent } from "./agent.ts";
export { Workspace } from "./workspace.ts";

interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  AGENT: DurableObjectNamespace<Agent>;
  ADMIN_KEY?: string;
  LLM?: unknown;
  LLM_FROM_REQUEST?: string;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { value } : { error: value }), {
    status,
    headers: { "content-type": "application/json" },
  });

function statusOf(message: string): number {
  const code = /^(?:Error: )?(E[A-Z]+):/.exec(message)?.[1];
  if (code === "EACCES" || code === "EPERM") return 403;
  if (code === "ENOENT") return 404;
  if (code === "EINVAL") return 400;
  if (code === "ENOSYS") return 501;
  return 500;
}

function sameKey(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const isAdmin = (req: Request, env: Env) => {
  const key = env.ADMIN_KEY;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  return !!key && !!given && sameKey(given, key);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const body = async <T>() => (request.method === "POST" ? ((await request.json()) as T) : ({} as T));
    try {
      if (parts[0] !== "api") return json("not found", 404);
      if (parts[1] === "runtime")
        return json({
          studio: 1,
          host: !!studioHost(),
          modelFromRequest: env.LLM_FROM_REQUEST === "1",
          deploymentModel: !!env.LLM,
        });

      if (parts[1] === "w" && parts[2]) {
        if (!isAdmin(request, env)) return json("admin key required", 401);
        const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(parts[2]));
        const [, , , what, sid, action] = parts;
        if (what === "sync" && request.method === "POST") {
          const b = await body<{ files: Record<string, SyncValue>; prune?: boolean }>();
          return json(await ws.sync(b.files, !!b.prune));
        }
        if (what === "changes") return json(await ws.changes(Number(url.searchParams.get("since") ?? 0)));
        if (what === "sessions" && !sid && request.method === "POST") {
          const b = await body<{ user: string; rights: string[]; mode?: string; model?: boolean }>();
          return json(await ws.startSession(b.user, b.rights, b.mode, b.model));
        }
        if (what === "sessions" && sid && !action) return json(await ws.sessionInfo(sid));
        if (what === "sessions" && sid && action === "mode")
          return json(await ws.setMode(sid, (await body<{ mode: string }>()).mode));
        if (what === "sessions" && sid && action === "revoke")
          return json(await ws.revoke(sid, (await body<{ rid?: string }>()).rid));
        return json("not found", 404);
      }

      if (parts[1] === "agents" && parts[2]) {
        const agent = env.AGENT.get(env.AGENT.idFromName(parts[2]));
        if (parts[3] === "run" && request.method === "POST") {
          const b = await body<{
            workspace: string;
            token: string;
            narrow?: { scope?: string | string[]; readOnly?: boolean };
            task: AgentRunRequest & { runId?: string };
          }>();
          const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(b.workspace));
          const files = (await ws.open(b.token, b.narrow)) as unknown as FilesStub;
          const llmToken = request.headers.get("x-llm-token") ?? undefined;
          return json(await agent.run(files, b.task, llmToken));
        }
        if (parts[3] === "runs" && parts[4] && parts[5] === "stop") return json(await agent.stop(parts[4]));
        if (parts[3] === "runs" && parts[4])
          return json(await agent.progress(parts[4], Number(url.searchParams.get("since") ?? 0)));
      }
      return json("not found", 404);
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      return json(message, statusOf(message));
    }
  },
};
